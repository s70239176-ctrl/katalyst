#![cfg_attr(not(feature = "std"), no_std, no_main)]
// ink! 4 event macros emit `usize as u8` casts that newer clippy flags; not our code.
#![allow(clippy::cast_possible_truncation)]

//! Katalyst Vault
//!
//! Escrow contract for AI-adjudicated intents. Users lock $POT together with a
//! natural-language prompt. A single authorized relayer carries the verdict of the
//! GenLayer consensus back on-chain, but the contract never trusts it blindly:
//! allocation totals, pool whitelisting, duplicate targets and re-entrancy are all
//! enforced deterministically here.

#[ink::contract]
mod katalyst_vault {
    use ink::env::{return_value, ReturnFlags};
    use ink::prelude::{string::String, vec::Vec};
    use ink::storage::Mapping;

    /// Upper bound on the stored prompt size (bytes).
    pub const MAX_PROMPT_BYTES: usize = 2048;
    /// Upper bound on the number of route legs per intent.
    pub const MAX_ALLOCATIONS: usize = 8;
    /// Upper bound on the length of an eco score label.
    pub const MAX_ECO_SCORE_BYTES: usize = 32;

    /// Raw public keys of the seeded eco-vault pools
    /// (Pool_Alpha, Pool_Beta, Pool_Gamma) as served by the GenLayer solver:
    /// 5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY,
    /// 5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM693dn,
    /// 5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y.
    const SEED_POOLS: [[u8; 32]; 3] = [
        [
            0xd4, 0x35, 0x93, 0xc7, 0x15, 0xfd, 0xd3, 0x1c, 0x61, 0x14, 0x1a, 0xbd, 0x04, 0xa9,
            0x9f, 0xd6, 0x82, 0x2c, 0x85, 0x58, 0x85, 0x4c, 0xcd, 0xe3, 0x9a, 0x56, 0x84, 0xe7,
            0xa5, 0x6d, 0xa2, 0x7d,
        ],
        [
            0x8e, 0xaf, 0x04, 0x15, 0x16, 0x87, 0x73, 0x63, 0x26, 0xc9, 0xfe, 0xa1, 0x7e, 0x25,
            0xfc, 0x52, 0x87, 0x61, 0x36, 0x93, 0xc9, 0x12, 0x90, 0x9c, 0xb2, 0x26, 0xaa, 0x47,
            0x94, 0xf2, 0x6a, 0x48,
        ],
        [
            0x90, 0xb5, 0xab, 0x20, 0x5c, 0x69, 0x74, 0xc9, 0xea, 0x84, 0x1b, 0xe6, 0x88, 0x86,
            0x46, 0x33, 0xdc, 0x9c, 0xa8, 0xa3, 0x57, 0x84, 0x3e, 0xea, 0xcf, 0x23, 0x14, 0x64,
            0x99, 0x65, 0xfe, 0x22,
        ],
    ];

    #[derive(Debug, Clone, Copy, PartialEq, Eq, scale::Encode, scale::Decode)]
    #[cfg_attr(
        feature = "std",
        derive(scale_info::TypeInfo, ink::storage::traits::StorageLayout)
    )]
    pub enum IntentStatus {
        PendingAdjudication,
        Executed,
        Cancelled,
        Rejected,
    }

    #[derive(Debug, Clone, PartialEq, Eq, scale::Encode, scale::Decode)]
    #[cfg_attr(
        feature = "std",
        derive(scale_info::TypeInfo, ink::storage::traits::StorageLayout)
    )]
    pub struct RouteAllocation {
        pub target_pool: AccountId,
        pub percentage: u8,
        pub eco_score: String,
    }

    #[derive(Debug, Clone, PartialEq, Eq, scale::Encode, scale::Decode)]
    #[cfg_attr(
        feature = "std",
        derive(scale_info::TypeInfo, ink::storage::traits::StorageLayout)
    )]
    pub struct IntentRecord {
        pub user: AccountId,
        pub amount: Balance,
        pub raw_prompt: String,
        pub status: IntentStatus,
        pub route: Option<Vec<RouteAllocation>>,
        pub created_at: Timestamp,
    }

    #[derive(Debug, PartialEq, Eq, scale::Encode, scale::Decode)]
    #[cfg_attr(feature = "std", derive(scale_info::TypeInfo))]
    pub enum CustomError {
        NotOwner,
        NotRelayer,
        NotIntentOwner,
        InsufficientPayment,
        InvalidPrompt,
        InvalidNonce,
        IntentNotPending,
        InvalidAllocationPercentage,
        PoolNotWhitelisted,
        TransferFailed,
        ArithmeticOverflow,
        Reentrancy,
    }

    pub type Result<T> = core::result::Result<T, CustomError>;

    #[ink(event)]
    pub struct IntentDeposited {
        #[ink(topic)]
        nonce: u64,
        #[ink(topic)]
        user: AccountId,
        amount: Balance,
        prompt: String,
    }

    #[ink(event)]
    pub struct IntentExecuted {
        #[ink(topic)]
        nonce: u64,
        total_amount: Balance,
    }

    #[ink(event)]
    pub struct IntentRejected {
        #[ink(topic)]
        nonce: u64,
        refunded: Balance,
    }

    #[ink(event)]
    pub struct IntentCancelled {
        #[ink(topic)]
        nonce: u64,
        refunded: Balance,
    }

    #[ink(event)]
    pub struct PoolWhitelisted {
        #[ink(topic)]
        pool: AccountId,
        status: bool,
    }

    #[ink(storage)]
    pub struct KatalystVault {
        owner: AccountId,
        authorized_relayer: AccountId,
        intent_nonce: u64,
        intents: Mapping<u64, IntentRecord>,
        whitelisted_pools: Mapping<AccountId, bool>,
        /// Re-entrancy guard, held for the duration of any message that moves funds.
        locked: bool,
    }

    impl KatalystVault {
        /// Caller becomes owner; `relayer` is the only account allowed to settle intents.
        #[ink(constructor)]
        pub fn new(relayer: AccountId) -> Self {
            let mut whitelisted_pools = Mapping::default();
            for raw in SEED_POOLS.iter() {
                whitelisted_pools.insert(AccountId::from(*raw), &true);
            }
            Self {
                owner: Self::env().caller(),
                authorized_relayer: relayer,
                intent_nonce: 0,
                intents: Mapping::default(),
                whitelisted_pools,
                locked: false,
            }
        }

        /// Lock the attached $POT against a natural-language intent. Returns its nonce.
        #[ink(message, payable)]
        pub fn deposit_intent(&mut self, prompt: String) -> Result<u64> {
            let amount = self.env().transferred_value();
            if amount == 0 {
                return Err(CustomError::InsufficientPayment);
            }
            if prompt.is_empty() || prompt.len() > MAX_PROMPT_BYTES {
                return Err(CustomError::InvalidPrompt);
            }

            let nonce = self
                .intent_nonce
                .checked_add(1)
                .ok_or(CustomError::ArithmeticOverflow)?;
            self.intent_nonce = nonce;

            let user = self.env().caller();
            self.intents.insert(
                nonce,
                &IntentRecord {
                    user,
                    amount,
                    raw_prompt: prompt.clone(),
                    status: IntentStatus::PendingAdjudication,
                    route: None,
                    created_at: self.env().block_timestamp(),
                },
            );

            self.env().emit_event(IntentDeposited {
                nonce,
                user,
                amount,
                prompt,
            });
            Ok(nonce)
        }

        /// Settle an intent with the route returned by GenLayer consensus.
        /// Relayer only. Every invariant is re-validated here; a failed transfer
        /// reverts the whole call.
        #[ink(message)]
        pub fn execute_adjudicated_intent(
            &mut self,
            nonce: u64,
            allocations: Vec<RouteAllocation>,
        ) -> Result<()> {
            self.ensure_relayer()?;

            // Validate everything before taking the lock so an error return never leaves it held.
            let mut record = self.pending_intent(nonce)?;
            self.validate_allocations(&allocations)?;
            self.enter()?;

            // Effects before interactions.
            let total = record.amount;
            record.status = IntentStatus::Executed;
            record.route = Some(allocations.clone());
            self.intents.insert(nonce, &record);

            let last = allocations.len().saturating_sub(1);
            let mut remaining = total;
            for (i, leg) in allocations.iter().enumerate() {
                let share = if i == last {
                    // Rounding dust goes to the final leg so the full deposit is distributed.
                    remaining
                } else {
                    total
                        .checked_mul(Balance::from(leg.percentage))
                        .ok_or(CustomError::ArithmeticOverflow)?
                        / 100
                };
                remaining = remaining
                    .checked_sub(share)
                    .ok_or(CustomError::ArithmeticOverflow)?;
                if share > 0 && self.env().transfer(leg.target_pool, share).is_err() {
                    Self::revert_with(CustomError::TransferFailed);
                }
            }

            self.env().emit_event(IntentExecuted {
                nonce,
                total_amount: total,
            });
            self.locked = false;
            Ok(())
        }

        /// Relayer-only: the solver rejected the intent (e.g. prompt injection or no
        /// compliant pool). The deposit is refunded to the depositor.
        #[ink(message)]
        pub fn reject_intent(&mut self, nonce: u64) -> Result<()> {
            self.ensure_relayer()?;
            self.refund(nonce, IntentStatus::Rejected)
        }

        /// Depositor-only escape hatch while the intent is still pending.
        #[ink(message)]
        pub fn cancel_intent(&mut self, nonce: u64) -> Result<()> {
            let record = self.intents.get(nonce).ok_or(CustomError::InvalidNonce)?;
            if record.user != self.env().caller() {
                return Err(CustomError::NotIntentOwner);
            }
            self.refund(nonce, IntentStatus::Cancelled)
        }

        #[ink(message)]
        pub fn add_whitelisted_pool(&mut self, pool: AccountId) -> Result<()> {
            self.ensure_owner()?;
            self.whitelisted_pools.insert(pool, &true);
            self.env().emit_event(PoolWhitelisted { pool, status: true });
            Ok(())
        }

        #[ink(message)]
        pub fn remove_whitelisted_pool(&mut self, pool: AccountId) -> Result<()> {
            self.ensure_owner()?;
            self.whitelisted_pools.remove(pool);
            self.env().emit_event(PoolWhitelisted {
                pool,
                status: false,
            });
            Ok(())
        }

        #[ink(message)]
        pub fn get_intent(&self, nonce: u64) -> Option<IntentRecord> {
            self.intents.get(nonce)
        }

        #[ink(message)]
        pub fn is_pool_whitelisted(&self, pool: AccountId) -> bool {
            self.whitelisted_pools.get(pool).unwrap_or(false)
        }

        #[ink(message)]
        pub fn get_relayer(&self) -> AccountId {
            self.authorized_relayer
        }

        #[ink(message)]
        pub fn get_owner(&self) -> AccountId {
            self.owner
        }

        #[ink(message)]
        pub fn get_intent_count(&self) -> u64 {
            self.intent_nonce
        }

        // ---- internals -------------------------------------------------------

        fn ensure_owner(&self) -> Result<()> {
            if self.env().caller() != self.owner {
                return Err(CustomError::NotOwner);
            }
            Ok(())
        }

        fn ensure_relayer(&self) -> Result<()> {
            if self.env().caller() != self.authorized_relayer {
                return Err(CustomError::NotRelayer);
            }
            Ok(())
        }

        fn enter(&mut self) -> Result<()> {
            if self.locked {
                return Err(CustomError::Reentrancy);
            }
            self.locked = true;
            Ok(())
        }

        fn pending_intent(&self, nonce: u64) -> Result<IntentRecord> {
            let record = self.intents.get(nonce).ok_or(CustomError::InvalidNonce)?;
            if record.status != IntentStatus::PendingAdjudication {
                return Err(CustomError::IntentNotPending);
            }
            Ok(record)
        }

        fn validate_allocations(&self, allocations: &[RouteAllocation]) -> Result<()> {
            if allocations.is_empty() || allocations.len() > MAX_ALLOCATIONS {
                return Err(CustomError::InvalidAllocationPercentage);
            }
            let mut sum: u32 = 0;
            for (i, leg) in allocations.iter().enumerate() {
                if leg.percentage == 0 || leg.eco_score.len() > MAX_ECO_SCORE_BYTES {
                    return Err(CustomError::InvalidAllocationPercentage);
                }
                if !self.is_pool_whitelisted(leg.target_pool) {
                    return Err(CustomError::PoolNotWhitelisted);
                }
                if allocations[..i]
                    .iter()
                    .any(|prev| prev.target_pool == leg.target_pool)
                {
                    // Duplicate legs are not allowed; they must be merged off-chain.
                    return Err(CustomError::InvalidAllocationPercentage);
                }
                sum = sum.saturating_add(u32::from(leg.percentage));
            }
            if sum != 100 {
                return Err(CustomError::InvalidAllocationPercentage);
            }
            Ok(())
        }

        fn refund(&mut self, nonce: u64, terminal: IntentStatus) -> Result<()> {
            let mut record = self.pending_intent(nonce)?;
            self.enter()?;

            record.status = terminal;
            let amount = record.amount;
            let user = record.user;
            self.intents.insert(nonce, &record);

            if self.env().transfer(user, amount).is_err() {
                Self::revert_with(CustomError::TransferFailed);
            }
            match terminal {
                IntentStatus::Cancelled => self.env().emit_event(IntentCancelled {
                    nonce,
                    refunded: amount,
                }),
                _ => self.env().emit_event(IntentRejected {
                    nonce,
                    refunded: amount,
                }),
            }
            self.locked = false;
            Ok(())
        }

        /// Abort execution and roll back every storage change made by this call.
        fn revert_with(err: CustomError) -> ! {
            let result: Result<()> = Err(err);
            return_value(ReturnFlags::new_with_reverted(true), &result)
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use ink::env::test::{default_accounts, set_caller, set_value_transferred, DefaultAccounts};
        use ink::env::DefaultEnvironment;

        fn accounts() -> DefaultAccounts<DefaultEnvironment> {
            default_accounts::<DefaultEnvironment>()
        }

        fn pool(i: usize) -> AccountId {
            AccountId::from(SEED_POOLS[i])
        }

        fn leg(i: usize, percentage: u8) -> RouteAllocation {
            RouteAllocation {
                target_pool: pool(i),
                percentage,
                eco_score: String::from("A-Tier"),
            }
        }

        fn deposited_vault() -> KatalystVault {
            let a = accounts();
            set_caller::<DefaultEnvironment>(a.alice);
            let mut vault = KatalystVault::new(a.bob);
            set_caller::<DefaultEnvironment>(a.charlie);
            set_value_transferred::<DefaultEnvironment>(1_000);
            assert_eq!(vault.deposit_intent(String::from("A-Tier only")), Ok(1));
            vault
        }

        #[ink::test]
        fn deposit_requires_payment() {
            let a = accounts();
            set_caller::<DefaultEnvironment>(a.alice);
            let mut vault = KatalystVault::new(a.bob);
            set_value_transferred::<DefaultEnvironment>(0);
            assert_eq!(
                vault.deposit_intent(String::from("x")),
                Err(CustomError::InsufficientPayment)
            );
        }

        #[ink::test]
        fn only_relayer_can_execute() {
            let mut vault = deposited_vault();
            let a = accounts();
            set_caller::<DefaultEnvironment>(a.charlie);
            assert_eq!(
                vault.execute_adjudicated_intent(1, vec![leg(0, 100)]),
                Err(CustomError::NotRelayer)
            );
        }

        #[ink::test]
        fn rejects_bad_totals_and_unlisted_pools() {
            let mut vault = deposited_vault();
            let a = accounts();
            set_caller::<DefaultEnvironment>(a.bob);
            assert_eq!(
                vault.execute_adjudicated_intent(1, vec![leg(0, 60), leg(1, 30)]),
                Err(CustomError::InvalidAllocationPercentage)
            );
            let rogue = RouteAllocation {
                target_pool: a.django,
                percentage: 100,
                eco_score: String::from("A-Tier"),
            };
            assert_eq!(
                vault.execute_adjudicated_intent(1, vec![rogue]),
                Err(CustomError::PoolNotWhitelisted)
            );
        }

        #[ink::test]
        fn owner_manages_whitelist() {
            let a = accounts();
            set_caller::<DefaultEnvironment>(a.alice);
            let mut vault = KatalystVault::new(a.bob);
            assert!(!vault.is_pool_whitelisted(a.django));
            assert_eq!(vault.add_whitelisted_pool(a.django), Ok(()));
            assert!(vault.is_pool_whitelisted(a.django));
            assert_eq!(vault.remove_whitelisted_pool(a.django), Ok(()));
            assert!(!vault.is_pool_whitelisted(a.django));
            set_caller::<DefaultEnvironment>(a.bob);
            assert_eq!(vault.add_whitelisted_pool(a.django), Err(CustomError::NotOwner));
        }
    }
}
