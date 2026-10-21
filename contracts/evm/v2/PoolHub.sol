// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24 <0.9.0;

interface IVaultOwner {
    function owner() external view returns (address);
}

/// @title PoolHub
/// @notice Holds the funds a KatalystVaultV2 routes to its pools, as per-user positions that can be seen and withdrawn.
///
/// A "pool" is identified by an arbitrary address key (the same addresses the solver routes to, so nothing off-chain
/// changes). The hub is a ledger: it records who is owed what and lets each user withdraw their own position. It does
/// not generate yield; the key can later point at a real strategy contract that the hub forwards to.
///
/// Authority: only the vault can deposit; only the vault's current owner can register pools, so there is a single
/// source of authority and the hub needs no admin storage of its own.
contract PoolHub {
    struct Pool {
        bool active;
        bytes8 eco; // e.g. "A-Tier", right-padded
    }

    address public immutable vault;

    mapping(address => Pool) public pools;
    /// @notice pool => user => amount held for that user.
    mapping(address => mapping(address => uint256)) public position;
    /// @notice pool => total held.
    mapping(address => uint256) public held;

    event PoolSet(address indexed pool, bool active, bytes8 eco);
    event PoolDeposit(address indexed pool, address indexed user, uint256 amount);
    event PoolWithdraw(address indexed pool, address indexed user, uint256 amount);

    error NotVault();
    error NotOwner();
    error PoolNotWhitelisted();
    error InsufficientPosition();
    error TransferFailed();

    constructor(address vault_) {
        vault = vault_;
    }

    function isPool(address pool) external view returns (bool) {
        return pools[pool].active;
    }

    /// @notice Called by the vault while settling an intent.
    function depositFor(address pool, address user) external payable {
        if (msg.sender != vault) revert NotVault();
        if (!pools[pool].active) revert PoolNotWhitelisted();
        position[pool][user] += msg.value;
        held[pool] += msg.value;
        emit PoolDeposit(pool, user, msg.value);
    }

    /// @notice Withdraw (part of) your own position. Always available, even while the vault is paused.
    function withdraw(address pool, uint256 amount) external {
        uint256 have = position[pool][msg.sender];
        if (amount == 0 || amount > have) revert InsufficientPosition();
        position[pool][msg.sender] = have - amount;
        held[pool] -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit PoolWithdraw(pool, msg.sender, amount);
    }

    function setPool(address pool, bool active, bytes8 eco) external {
        if (msg.sender != IVaultOwner(vault).owner()) revert NotOwner();
        pools[pool] = Pool(active, eco);
        emit PoolSet(pool, active, eco);
    }
}
