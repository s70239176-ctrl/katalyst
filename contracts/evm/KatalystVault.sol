// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24 <0.9.0;

/// @title KatalystVault
/// @notice Escrow for AI-adjudicated intents on PortaldotV3 (pallet-revive / EVM RPC).
///
/// Users lock native $POT with a natural-language prompt. A single relayer carries the GenLayer
/// consensus verdict back on-chain, but this contract re-validates everything deterministically:
/// percentages must total 100, every target must be whitelisted, no duplicate legs, and the
/// relayer must present the exact (user, amount, prompt hash) that was committed at deposit time.
///
/// Storage is deliberately minimal because PortaldotV3 charges a storage deposit per item/byte:
/// a pending intent costs ONE slot (a commitment hash). The prompt, route and status live in
/// events, and the commitment is deleted when the intent settles (which also blocks replays).
contract KatalystVault {
    struct Leg {
        address pool;
        uint8 pct;
        bytes8 eco; // e.g. "A-Tier" right-padded with zero bytes
    }

    uint256 private constant MAX_PROMPT = 2048;
    uint256 private constant MAX_LEGS = 8;

    address public immutable owner;
    address public immutable relayer;

    uint64 public intentCount;
    /// @notice nonce => keccak256(abi.encode(nonce, user, amount, keccak256(prompt))); zero once settled.
    mapping(uint64 => bytes32) public pending;
    mapping(address => bool) public whitelisted;

    event IntentDeposited(uint64 indexed nonce, address indexed user, uint256 amount, string prompt);
    event IntentExecuted(uint64 indexed nonce, address indexed user, uint256 totalAmount);
    event RouteLeg(uint64 indexed nonce, address indexed pool, uint8 pct, bytes8 eco, uint256 amount);
    event IntentRejected(uint64 indexed nonce, address indexed user, uint256 refunded);
    event IntentCancelled(uint64 indexed nonce, address indexed user, uint256 refunded);
    event PoolWhitelisted(address indexed pool, bool status);

    error NotOwner();
    error NotRelayer();
    error InsufficientPayment();
    error InvalidPrompt();
    error IntentNotPending();
    error InvalidAllocation();
    error PoolNotWhitelisted();
    error TransferFailed();

    constructor(address relayer_, address[] memory pools) {
        owner = msg.sender;
        relayer = relayer_;
        for (uint256 i = 0; i < pools.length; i++) {
            whitelisted[pools[i]] = true;
            emit PoolWhitelisted(pools[i], true);
        }
    }

    /// @notice Lock msg.value against an intent. Returns its nonce.
    function depositIntent(string calldata prompt) external payable returns (uint64 nonce) {
        if (msg.value == 0) revert InsufficientPayment();
        uint256 len = bytes(prompt).length;
        if (len == 0 || len > MAX_PROMPT) revert InvalidPrompt();

        nonce = ++intentCount;
        pending[nonce] = keccak256(abi.encode(nonce, msg.sender, msg.value, keccak256(bytes(prompt))));
        emit IntentDeposited(nonce, msg.sender, msg.value, prompt);
    }

    /// @notice Relayer-only: settle an intent with the route agreed by GenLayer consensus.
    function executeAdjudicatedIntent(
        uint64 nonce,
        address user,
        uint256 amount,
        bytes32 promptHash,
        Leg[] calldata legs
    ) external {
        if (msg.sender != relayer) revert NotRelayer();
        _consume(nonce, user, amount, promptHash);

        uint256 n = legs.length;
        if (n == 0 || n > MAX_LEGS) revert InvalidAllocation();
        uint256 total;
        for (uint256 i = 0; i < n; i++) {
            if (legs[i].pct == 0) revert InvalidAllocation();
            if (!whitelisted[legs[i].pool]) revert PoolNotWhitelisted();
            for (uint256 j = 0; j < i; j++) {
                if (legs[j].pool == legs[i].pool) revert InvalidAllocation();
            }
            total += legs[i].pct;
        }
        if (total != 100) revert InvalidAllocation();

        // The commitment was deleted in _consume (checks-effects-interactions), so a re-entering
        // pool cannot settle or cancel this intent again.
        uint256 remaining = amount;
        for (uint256 i = 0; i < n; i++) {
            // Rounding dust goes to the last leg so the full deposit is distributed.
            uint256 share = i == n - 1 ? remaining : (amount * legs[i].pct) / 100;
            remaining -= share;
            _send(legs[i].pool, share);
            emit RouteLeg(nonce, legs[i].pool, legs[i].pct, legs[i].eco, share);
        }
        emit IntentExecuted(nonce, user, amount);
    }

    /// @notice Relayer-only: the solver rejected the intent; refund the depositor.
    function rejectIntent(uint64 nonce, address user, uint256 amount, bytes32 promptHash) external {
        if (msg.sender != relayer) revert NotRelayer();
        _consume(nonce, user, amount, promptHash);
        _send(user, amount);
        emit IntentRejected(nonce, user, amount);
    }

    /// @notice Depositor escape hatch while the intent is still pending.
    function cancelIntent(uint64 nonce, uint256 amount, bytes32 promptHash) external {
        _consume(nonce, msg.sender, amount, promptHash);
        _send(msg.sender, amount);
        emit IntentCancelled(nonce, msg.sender, amount);
    }

    function setPoolWhitelisted(address pool, bool status) external {
        if (msg.sender != owner) revert NotOwner();
        whitelisted[pool] = status;
        emit PoolWhitelisted(pool, status);
    }

    function _consume(uint64 nonce, address user, uint256 amount, bytes32 promptHash) private {
        bytes32 c = pending[nonce];
        if (c == bytes32(0) || c != keccak256(abi.encode(nonce, user, amount, promptHash))) {
            revert IntentNotPending();
        }
        delete pending[nonce];
    }

    function _send(address to, uint256 amount) private {
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
