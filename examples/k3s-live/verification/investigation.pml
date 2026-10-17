/* MCP acquisition/assessment composition, one immutable admitted Run identity.
 * Four host delegate invocation identities and four required actor identities,
 * at most two server restarts. Each
 * slot abstracts an admitted inference/tool request; the model checks the tool
 * side effect lifecycle, not model text or MCP transport internals.
 *
 * Durable state survives every restart. A reserved but unrecorded operation is
 * uncertain even if its external call had not begun. Restart cannot establish
 * absence of an effect. There is no automatic retry of that identity.
 *
 * Atomic blocks map only to one synchronous host dispatch/cancellation check,
 * one durable state commit, or abstract host ledger recovery. They do not hide
 * an external call together with its recorded response or evidence freezing
 * together with assessment launch. The implementation is a single owner;
 * storage loss, unbounded crashes and overlapping orchestrators are excluded.
 */
#define TOOLS 4
#define ALL_REQUIRED 15
mtype = { Acquiring, Acquired, Frozen, Assessing, Completed, Blocked, Cancelled,
          Unused, Reserved, Invoked, Recorded, Uncertain };
mtype phase = Acquiring;
mtype tool[TOOLS];
byte calls[TOOLS];
byte actor[TOOLS];
byte covered = 0;
byte order_code = 0;
byte slot = 0;
byte results = 0;
byte restarts = 0;
byte frozen_version = 0;
byte assessment_starts = 0;
bool all_trusted = true;
bool unavailable_observation = false;
bool has_unknown = false;
bool recorded_restart = false;
bool frozen_restart = false;
bool cancelled = false;
bool done = false;

/* This independent action can interleave between all persisted phase changes.
 * Cancellation after assessment has started may stop existing work; it does
 * not retrospectively invalidate a dispatch made before cancellation. */
active proctype Cancellation() {
    if :: cancelled = true :: skip fi
}

active proctype Investigation() {
    byte i;
    atomic {
        i = 0;
        do :: i < TOOLS -> tool[i] = Unused; i++ :: else -> break od
    }
    do
    :: done -> break
    :: atomic { !done && cancelled -> phase = Cancelled; done = true }
    :: atomic {
         !done && !cancelled && restarts < 2 ->
         restarts++;
         if :: phase == Acquiring && tool[slot] == Recorded -> recorded_restart = true
            :: else -> skip fi;
         if :: phase == Frozen -> frozen_restart = true :: else -> skip fi;
         /* Acknowledged records and frozen bytes survive process replacement. */
         if
         :: phase == Acquiring && (tool[slot] == Reserved || tool[slot] == Invoked) ->
            tool[slot] = Uncertain; has_unknown = true
         :: else -> skip
         fi;
#ifdef BUG_MCP_REPLAY
         if
         :: phase == Acquiring && tool[slot] == Recorded ->
            tool[slot] = Unused
         :: else -> skip
         fi;
#endif
#ifdef BUG_MCP_REFREEZE
         if :: phase == Frozen -> frozen_version++ :: else -> skip fi;
#endif
         assert(frozen_version <= 1)
       }
    :: atomic {
         !done && !cancelled && phase == Acquiring && tool[slot] == Unused ->
         /* The freezer also handles incomplete or repeated-target histories
          * retained by an older host. Actor identity differs from call identity. */
         if :: actor[slot] = 0 :: actor[slot] = 1
            :: actor[slot] = 2 :: actor[slot] = 3 fi;
         tool[slot] = Reserved
       }
    :: atomic {
         !done && !cancelled && phase == Acquiring && tool[slot] == Reserved ->
         /* Reservation precedes the external call; its response is separate. */
         assert(!cancelled);
         calls[slot]++;
         assert(calls[slot] <= 1);
         tool[slot] = Invoked
       }
    :: atomic {
         !done && !cancelled && phase == Acquiring && tool[slot] == Invoked ->
         if
         :: tool[slot] = Recorded; results++;
            covered = covered | (1 << actor[slot]);
            order_code = order_code * TOOLS + actor[slot];
            /* A valid unavailable observation records an attempted tool. It
             * supplies coverage, not useful proof for a remediation action. */
            if :: skip :: unavailable_observation = true fi;
            /* Exact subject UID, known actor/tool, result/schema and evidence
             * consistency are conjunctive predicates checked in trusted code. */
            if :: skip :: all_trusted = false fi
         :: tool[slot] = Uncertain; has_unknown = true
         fi
       }
    :: atomic {
         !done && !cancelled && phase == Acquiring && tool[slot] == Recorded ->
         if
         :: phase = Acquired
         :: slot < TOOLS - 1 -> slot++
         fi
       }
    :: atomic {
         !done && !cancelled && phase == Acquiring && tool[slot] == Uncertain ->
#ifdef BUG_MCP_UNKNOWN
         phase = Acquired
#else
         phase = Blocked; done = true
#endif
       }
    :: atomic {
         !done && !cancelled && phase == Acquired ->
         assert(!has_unknown);
#ifdef BUG_MCP_SUBJECT
         if :: !has_unknown && covered == ALL_REQUIRED ->
#else
#ifdef BUG_MCP_PARTIAL_COVERAGE
         if :: all_trusted && !has_unknown && results > 0 ->
#else
#ifdef BUG_MCP_DUPLICATE_COVERAGE
         if :: all_trusted && !has_unknown && results == TOOLS ->
#else
         if :: all_trusted && !has_unknown && covered == ALL_REQUIRED ->
#endif
#endif
#endif
            assert(covered == ALL_REQUIRED);
            assert(all_trusted);
            assert(!has_unknown);
            frozen_version++;
            assert(frozen_version == 1);
            phase = Frozen
         :: else -> phase = Blocked; done = true
         fi
       }
#ifdef BUG_MCP_EARLY_ASSESSMENT
    :: atomic {
         !done && !cancelled && phase == Acquired ->
         assert(frozen_version == 1); assessment_starts++; phase = Assessing
       }
#endif
    :: atomic {
#ifdef BUG_MCP_CANCEL
         !done && phase == Frozen ->
#else
         !done && !cancelled && phase == Frozen ->
#endif
         /* Persisted frozen input precedes synchronous dispatch admission. */
         assert(!cancelled);
         assert(frozen_version == 1 && all_trusted && !has_unknown);
         assert(covered == ALL_REQUIRED);
         assessment_starts++;
         assert(assessment_starts == 1);
         phase = Assessing
       }
    :: atomic {
         !done && !cancelled && phase == Assessing ->
         /* The existing revision.pml covers the later candidate loop. */
         phase = Completed; done = true
       }
#ifdef BUG_MCP_STALL
    :: !done && phase == Acquiring -> skip
#endif
    od;
    assert(results <= TOOLS);
    assert(frozen_version <= 1);
#ifdef WITNESS_MCP_SUCCESS
    assert(!(phase == Completed && results == TOOLS));
#endif
#ifdef WITNESS_MCP_REVERSE_ORDER
    assert(!(phase == Completed && order_code == 228));
#endif
#ifdef WITNESS_MCP_UNAVAILABLE
    assert(!(phase == Completed && unavailable_observation));
#endif
#ifdef WITNESS_MCP_PARTIAL_BLOCKED
    assert(!(phase == Blocked && all_trusted && !has_unknown && results == 1));
#endif
#ifdef WITNESS_MCP_DUPLICATE_BLOCKED
    assert(!(phase == Blocked && all_trusted && !has_unknown && results == TOOLS && covered != ALL_REQUIRED));
#endif
#ifdef WITNESS_MCP_RESTART
    assert(!(phase == Completed && recorded_restart && frozen_restart));
#endif
#ifdef WITNESS_MCP_UNCERTAIN
    assert(!(phase == Blocked && has_unknown && calls[slot] == 1));
#endif
}

ltl investigation_settles { <> done }
