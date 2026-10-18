/* Two independent controller processes contend for one target journal.
 * Only a successful compare-and-set response grants effect authority. A
 * lost reservation response leaves an unresolved intent and no retry.
 * Target freshness is checked at the effect boundary, including after the
 * owner claim. The environment may change the target between these steps.
 * Cancellation blocks new admission. An already admitted external request
 * may complete after cancellation, and must subsequently be reconciled.
 */
byte owner = 0;
byte effects = 0;
byte target = 1;
byte observed_target = 1;
/* Generation abstracts the complete candidate/contract/tests/environment/image
 * tuple already admitted by eligibility.pml. A later change invalidates it. */
byte current_generation = 1;
byte verified_generation = 1;
byte finished = 0;
bool cancelled = false;
bool verification_passed = true;

#ifdef BUG_UNVERIFIED_PROMOTION
#define verification_guard true
#else
#define verification_guard verification_passed
#endif
#ifdef BUG_PROMOTION_CANCEL
#define active_guard true
#else
#define active_guard (!cancelled)
#endif

#ifdef BUG_PROMOTION_IDENTITY
#define current_identity true
#else
#define current_identity (current_generation == verified_generation)
#endif
#ifdef BUG_STALE_TARGET
#define target_guard true
#else
#define target_guard (target == observed_target)
#endif

proctype Controller(byte id) {
    bool claim = false;
    bool ack = false;
    bool admitted = false;
    atomic {
#ifdef BUG_OWNER
        if :: true -> owner = id; claim = true fi
#else
        if :: owner == 0 -> owner = id; claim = true :: else -> skip fi
#endif
    };
    if :: ack = true :: ack = false fi;
    if
#ifdef BUG_CLAIM_ACK
    :: claim ->
#else
    :: claim && ack ->
#endif
        atomic {
            if
            :: active_guard && verification_guard && target_guard && current_identity ->
                assert(ack); /* ACKNOWLEDGED_EFFECT_AUTHORITY */
                assert(!cancelled); /* NO_NEW_ADMISSION_AFTER_CANCELLATION */
                assert(verification_passed); /* NO_UNVERIFIED_PROMOTION */
                admitted = true
            :: else -> skip
            fi
        };
        /* External target preconditions are enforced when the asynchronous
         * request is applied. Cancellation cannot retract an in-flight call. */
        atomic {
            if
            :: admitted && target_guard && current_identity ->
                assert(target == observed_target); /* FRESH_TARGET_PRECONDITION */
                assert(current_generation == verified_generation); /* CURRENT_CANDIDATE_AT_PROMOTION */
                effects++;
                assert(effects <= 1) /* SINGLE_PROMOTION_OWNER */
            :: else -> skip
            fi
        }
    :: else -> skip
    fi;
    atomic { finished++ }
}

proctype Environment() {
    if :: target = 2 :: skip fi;
    if :: current_generation = 2 :: skip fi;
    if :: cancelled = true :: skip fi
}

init {
    if :: verification_passed = true :: verification_passed = false fi;
    atomic { run Controller(1); run Controller(2); run Environment() }
}
