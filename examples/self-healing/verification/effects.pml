/* A durable journal survives two process incarnations. A reserved command
 * without a retained response remains Reserved or becomes UNKNOWN. Both
 * states block new work. An external reconciliation
 * may establish absence, completion, or continued uncertainty. No new phase
 * and no dispatch may cross that uncertainty. Ordinary failed measurements
 * are COMPLETED, permit a new phase, and consume their original charge.
 * Each reservation abstracts one atomic SQLite transaction; transport and
 * persistence are separate transitions. Actual times/currency are bounded
 * admission units. Journal/runner loss is deliberately outside this model.
 */
mtype = { None, Reserved, Completed, Unknown };
mtype effect = None;
byte charged = 0;
byte persisted_used = 0;
byte budget = 1;
byte phase = 0;
byte boot = 0;
byte dispatches = 0;
byte unresolved_dispatches = 0;
bool cancelled = false;
bool ever_cancelled = false;
bool failed_measurement = false;
bool first_failed = false;
bool response_received;
bool restarted = false;
bool reconciled = false;

#ifdef BUG_UNKNOWN_PHASE
#define phase_clear (effect != Reserved)
#elif defined(BUG_RESERVED_PHASE)
#define phase_clear (effect != Unknown)
#else
#define phase_clear (effect != Unknown && effect != Reserved)
#endif
#ifdef BUG_UNKNOWN_REPEAT
#define dispatch_clear (effect != Reserved)
#elif defined(BUG_RESERVED_REPEAT)
#define dispatch_clear (effect != Unknown)
#else
#define dispatch_clear (effect != Unknown && effect != Reserved)
#endif
#ifdef BUG_CANCEL
#define cancel_guard true
#else
#define cancel_guard (!cancelled)
#endif

init {
    if :: budget = 1 :: budget = 2 fi;
    do
    :: boot < 2 ->
        if :: cancelled = true; ever_cancelled = true :: skip fi;
        if
        :: phase_clear && cancel_guard && persisted_used < budget ->
            assert(effect != Unknown && effect != Reserved); /* UNKNOWN_BLOCKS_NEW_PHASE */
            assert(!cancelled); /* DURABLE_CANCELLATION */
            assert(!ever_cancelled); /* CANCELLATION_SURVIVES_RESTART */
            phase++
        :: else -> skip
        fi;
        if
        :: dispatch_clear && cancel_guard && persisted_used < budget ->
            assert(effect != Unknown && effect != Reserved); /* UNRESOLVED_EFFECT_NOT_REPEATED */
            assert(!cancelled); /* DURABLE_CANCELLATION */
            assert(!ever_cancelled); /* CANCELLATION_SURVIVES_RESTART */
            atomic {
                effect = Reserved;
                persisted_used++;
                charged++;
                assert(charged <= budget) /* PERSISTENT_BUDGET */
            };
            if :: skip :: goto restart fi; /* Crash before transport dispatch. */
            dispatches++;
            if :: skip :: goto restart fi; /* Crash before response persistence. */
            if :: response_received = true :: response_received = false fi;
            if
            :: response_received ->
                effect = Completed;
                if :: failed_measurement = true :: failed_measurement = false fi;
                if :: boot == 0 && failed_measurement -> first_failed = true :: else -> skip fi
            :: !response_received -> effect = Unknown; unresolved_dispatches++
            fi
        :: else -> skip
        fi;
restart:
        boot++;
        if
        :: boot == 1 ->
            restarted = true;
#ifdef BUG_CANCEL_RESET
            cancelled = false;
#endif
#ifdef BUG_BUDGET_RESET
            persisted_used = 0;
#endif
            if
            :: effect == Unknown || effect == Reserved ->
                if
                :: skip /* No reliable external observation: retain UNKNOWN. */
                :: effect = Completed; reconciled = true /* Exact external receipt. */
                :: effect = None; reconciled = true /* Authoritative non-occurrence. */
                fi
            :: else -> skip
            fi
        :: else -> skip
        fi
    :: boot == 2 -> break
    od;
#ifdef WITNESS_FAILED_REVISION
    assert(!(first_failed && phase == 2))
#endif
#ifdef WITNESS_UNKNOWN_RESTART
    assert(!(restarted && unresolved_dispatches == 1 && !reconciled))
#endif
#ifdef WITNESS_RESERVED_RESTART
    assert(!(restarted && effect == Reserved && !reconciled))
#endif
}
