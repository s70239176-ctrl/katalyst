// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24 <0.9.0;

interface IPoolHub {
    function depositFor(address pool, address user) external payable;
}

/// @title KatalystVaultV2
/// @notice Escrow for AI-adjudicated intents on PortaldotV3 (pallet-revive / EVM RPC). Same core design as v1
/// (one commitment slot per pending intent, relayer-only settlement re-validated on-chain) plus:
///
///  C1  `refundExpired`        anyone can refund an intent after its timeout, so funds are never stranded
///  C2  pause · two-step ownership · relayer rotation · per-intent deposit cap
///  C3  fixed protocol fee, locked at deployment, taken on settlement/rejection (never on cancel or expiry)
///  C5  opt-in route lock: the depositor commits to the exact route they previewed
///  C6  routes pay a PoolHub that holds real, withdrawable per-user positions
///  C7  optimistic settlement delay: with `delay > 0` the relayer can only *propose* a route; anyone finalises it
///      after the delay, and the owner can veto it in between (full refund). Bounds a compromised relayer.
///
/// Storage is minimal because PortaldotV3 charges a storage deposit per item and byte: policy values are immutable,
/// and a pending intent is one hash that is deleted on settlement.
contract KatalystVaultV2 {
    /// @dev Everything the vault committed to at deposit time. The relayer must present it unchanged.
    struct Intent {
        uint64 nonce;
        address user;
        uint256 amount;
        bytes32 promptHash;
        bytes32 routeLock; // 0 = no lock; else the chained hash of the route the user previewed
        uint64 expiry; // unix seconds; after this anyone may refund
    }

    struct Leg {
        address pool;
        uint8 pct;
        bytes8 eco;
    }

    uint256 private constant MAX_PROMPT = 2048;
    uint256 private constant MAX_LEGS = 8;

    // ---- policy, fixed at deployment (immutables cost no storage deposit) ----
    IPoolHub public immutable hub;
    /// @notice Taken from the deposit when the relayer executes or rejects an intent (covers its gas, deters spam).
    uint256 public immutable feeWei;
    /// @notice Per-intent deposit cap; 0 disables it.
    uint256 public immutable maxDeposit;
    /// @notice Seconds after deposit until `refundExpired` opens.
    uint64 public immutable ttl;
    /// @notice Seconds a proposed settlement waits before it can be finalised; 0 = the relayer settles immediately.
    uint64 public immutable delay;

    // ---- state: one packed slot, then two address slots ----
    address public owner;
    bool public paused;
    uint64 public intentCount;
    address public relayer;
    address public pendingOwner;

    /// @notice nonce => keccak256(abi.encode(intent)); zero once settled.
    mapping(uint64 => bytes32) public pending;
    /// @notice nonce => keccak256(legsHash, readyAt) of a proposed settlement (delay > 0 only).
    mapping(uint64 => bytes32) public proposed;

    event IntentDeposited(uint64 indexed nonce, address indexed user, uint256 amount, string prompt, bytes32 routeLock, uint64 expiry);
    event IntentExecuted(uint64 indexed nonce, address indexed user, uint256 netAmount, uint256 fee);
    event RouteLeg(uint64 indexed nonce, address indexed pool, uint8 pct, bytes8 eco, uint256 amount);
    event IntentRejected(uint64 indexed nonce, address indexed user, uint256 refunded, uint256 fee);
    event IntentCancelled(uint64 indexed nonce, address indexed user, uint256 refunded);
    event IntentExpired(uint64 indexed nonce, address indexed user, uint256 refunded, address indexed caller);
    event SettlementProposed(uint64 indexed nonce, bytes32 legsHash, uint64 readyAt);
    event SettlementVetoed(uint64 indexed nonce, address indexed user, uint256 refunded);
    event RelayerChanged(address indexed previousRelayer, address indexed newRelayer);
    event PausedSet(bool paused);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotRelayer();
    error NotDepositor();
    error NotPendingOwner();
    error Paused();
    error InsufficientPayment();
    error DepositTooLarge();
    error InvalidPrompt();
    error IntentNotPending();
    error Expired();
    error NotExpired();
    error InvalidAllocation();
    error RouteMismatch();
    error AlreadyProposed();
    error NoProposal();
    error NotReady();
    error TransferFailed();

    constructor(IPoolHub hub_, address relayer_, uint256 feeWei_, uint256 maxDeposit_, uint64 ttl_, uint64 delay_) {
        hub = hub_;
        relayer = relayer_;
        feeWei = feeWei_;
        maxDeposit = maxDeposit_;
        ttl = ttl_;
        delay = delay_;
        owner = msg.sender;
    }

    // ------------------------------------------------------------------ deposit

    /// @notice Lock msg.value against an intent. `routeLock` is 0, or the chained hash of the route you previewed
    /// (see the note above `_validate`); with a lock, the relayer can only settle exactly that route.
    function depositIntent(string calldata prompt, bytes32 routeLock) external payable returns (uint64 nonce) {
        if (paused) revert Paused();
        if (msg.value <= feeWei) revert InsufficientPayment();
        if (maxDeposit != 0 && msg.value > maxDeposit) revert DepositTooLarge();
        uint256 len = bytes(prompt).length;
        if (len == 0 || len > MAX_PROMPT) revert InvalidPrompt();

        nonce = ++intentCount;
        uint64 expiry = uint64(block.timestamp) + ttl;
        pending[nonce] = keccak256(abi.encode(Intent(nonce, msg.sender, msg.value, keccak256(bytes(prompt)), routeLock, expiry)));
        emit IntentDeposited(nonce, msg.sender, msg.value, prompt, routeLock, expiry);
    }

    // ------------------------------------------------------------------ settlement (relayer)

    /// @notice Settle an intent with the route GenLayer's validators agreed on. Blocked while paused.
    /// With `delay == 0` funds move now; otherwise this records a proposal that anyone can finalise after the delay.
    function executeAdjudicatedIntent(Intent calldata i, Leg[] calldata legs) external {
        if (msg.sender != relayer) revert NotRelayer();
        if (paused) revert Paused();
        if (block.timestamp >= i.expiry) revert Expired();
        _validate(i, legs);

        if (delay == 0) {
            _consume(i);
            _pay(i, legs);
        } else {
            if (pending[i.nonce] != keccak256(abi.encode(i))) revert IntentNotPending();
            if (proposed[i.nonce] != bytes32(0)) revert AlreadyProposed();
            uint64 readyAt = uint64(block.timestamp) + delay;
            bytes32 legsHash = keccak256(abi.encode(legs));
            proposed[i.nonce] = keccak256(abi.encode(legsHash, readyAt));
            emit SettlementProposed(i.nonce, legsHash, readyAt);
        }
    }

    /// @notice Anyone: pay out a proposed settlement once its delay has passed (and it was not vetoed).
    function finalizeSettlement(Intent calldata i, Leg[] calldata legs, uint64 readyAt) external {
        if (paused) revert Paused();
        if (block.timestamp < readyAt) revert NotReady();
        if (block.timestamp >= i.expiry) revert Expired();
        if (proposed[i.nonce] != keccak256(abi.encode(keccak256(abi.encode(legs)), readyAt))) revert NoProposal();
        _consume(i); // also clears the proposal
        _pay(i, legs);
    }

    /// @notice Owner only: cancel a proposed settlement during its delay. The depositor is refunded in full.
    function vetoSettlement(Intent calldata i) external {
        if (msg.sender != owner) revert NotOwner();
        if (proposed[i.nonce] == bytes32(0)) revert NoProposal();
        _consume(i);
        _send(i.user, i.amount);
        emit SettlementVetoed(i.nonce, i.user, i.amount);
    }

    /// @notice The solver rejected the intent: refund the depositor minus the fixed fee. Allowed while paused.
    function rejectIntent(Intent calldata i) external {
        if (msg.sender != relayer) revert NotRelayer();
        _consume(i);
        uint256 back = i.amount - feeWei;
        _send(i.user, back);
        _send(msg.sender, feeWei);
        emit IntentRejected(i.nonce, i.user, back, feeWei);
    }

    // ------------------------------------------------------------------ exits (no fee)

    /// @notice Depositor escape hatch while the intent is pending: full refund.
    function cancelIntent(Intent calldata i) external {
        if (msg.sender != i.user) revert NotDepositor();
        _consume(i);
        _send(i.user, i.amount);
        emit IntentCancelled(i.nonce, i.user, i.amount);
    }

    /// @notice Anyone may refund an intent whose timeout has passed: full refund to the depositor, no gas needed
    /// from them. This is what keeps funds from being stranded if the relayer goes offline.
    function refundExpired(Intent calldata i) external {
        if (block.timestamp < i.expiry) revert NotExpired();
        _consume(i);
        _send(i.user, i.amount);
        emit IntentExpired(i.nonce, i.user, i.amount, msg.sender);
    }

    // ------------------------------------------------------------------ admin

    function setRelayer(address newRelayer) external {
        if (msg.sender != owner) revert NotOwner();
        emit RelayerChanged(relayer, newRelayer);
        relayer = newRelayer;
    }

    /// @notice Pause blocks new deposits and relayer *execution*; rejections, cancels, expiries, vetoes and pool
    /// withdrawals keep working, so a pause can never trap funds.
    function setPaused(bool value) external {
        if (msg.sender != owner) revert NotOwner();
        paused = value;
        emit PausedSet(value);
    }

    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert NotOwner();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ------------------------------------------------------------------ helpers

    // routeLock = chained hash over the legs in order: h0 = 0, h = keccak256(abi.encodePacked(h, pool, pct)).
    // It is computed off-chain by the client (see the SDK's `routeLockOf`) and checked in `_validate`.

    /// @dev Structure, totals and (if set) the depositor's route lock. Does not touch state.
    function _validate(Intent calldata i, Leg[] calldata legs) private view {
        uint256 n = legs.length;
        if (n == 0 || n > MAX_LEGS) revert InvalidAllocation();
        uint256 total;
        bytes32 lock;
        for (uint256 k = 0; k < n; k++) {
            Leg calldata leg = legs[k];
            if (leg.pct == 0) revert InvalidAllocation();
            for (uint256 j = 0; j < k; j++) {
                if (legs[j].pool == leg.pool) revert InvalidAllocation();
            }
            total += leg.pct;
            lock = keccak256(abi.encodePacked(lock, leg.pool, leg.pct));
        }
        if (total != 100) revert InvalidAllocation();
        if (i.routeLock != bytes32(0) && lock != i.routeLock) revert RouteMismatch();
    }

    /// @dev Pay the route. The commitment is already deleted (checks-effects-interactions). The hub rejects any pool
    /// that is not registered, which reverts the whole settlement.
    function _pay(Intent calldata i, Leg[] calldata legs) private {
        uint256 n = legs.length;
        uint256 net = i.amount - feeWei;
        uint256 remaining = net;
        for (uint256 k = 0; k < n; k++) {
            // Rounding dust goes to the last leg so the whole net amount is distributed.
            uint256 share = k == n - 1 ? remaining : (net * legs[k].pct) / 100;
            remaining -= share;
            hub.depositFor{value: share}(legs[k].pool, i.user);
            emit RouteLeg(i.nonce, legs[k].pool, legs[k].pct, legs[k].eco, share);
        }
        _send(msg.sender, feeWei);
        emit IntentExecuted(i.nonce, i.user, net, feeWei);
    }

    function _consume(Intent calldata i) private {
        bytes32 c = pending[i.nonce];
        if (c == bytes32(0) || c != keccak256(abi.encode(i))) revert IntentNotPending();
        delete pending[i.nonce];
        delete proposed[i.nonce];
    }

    function _send(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
