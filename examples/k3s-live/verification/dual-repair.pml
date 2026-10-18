/* Two incident-driven repairs using the existing MAS/controller mechanisms.
 * Run 0: collected evidence, checkout, /readyz -> /healthz.
 * Run 1: MCP evidence, checkout-mcp, /ready -> /healthz.
 *
 * IDs 1 and 2 abstract distinct exact Kubernetes Run/Event/Pod/Deployment UIDs.
 * Equality denotes comparison of retained values, not cryptographic security.
 * One process per incident; the existing controller.pml separately checks
 * overlapping owners, CAS, crashes, unknown effects and immutable publication.
 * investigation.pml checks four-tool coverage and the earlier freeze lifecycle.
 * This composition checks the new authority boundary: assessment completion
 * alone never authorises a different source, seed, approach or workload.
 */
#define RUNS 2
mtype = { Unseen, Detected, Assessed, Rejected, Reserved, Applied, Verified };
mtype phase[RUNS];
byte effects[RUNS];
byte journal_source[RUNS];
byte finished = 0;

#ifdef BUG_DUAL_SOURCE
#define source_admitted true
#else
#define source_admitted (snapshot_run == source_run && snapshot_event == source_event)
#endif
#ifdef BUG_DUAL_SEED
#define seed_admitted true
#else
#define seed_admitted (snapshot_seed == source_seed && evidence_subject == source_seed)
#endif
#ifdef BUG_DUAL_APPROACH
#define approach_admitted true
#else
#define approach_admitted (snapshot_approach == id)
#endif
#ifdef BUG_DUAL_FREEZE
#define freeze_admitted true
#else
#define freeze_admitted (id == 0 || frozen_trusted)
#endif
#ifdef BUG_DUAL_TARGET
#define target_admitted true
#else
#define target_admitted (evidence_target == source_run && proposal_target == evidence_target)
#endif
#define admission (source_admitted && seed_admitted && approach_admitted && freeze_admitted && target_admitted)

proctype Incident(byte id) {
    byte source_run = id + 1;
    byte source_event = id + 1;
    byte source_seed = id + 1;
    byte snapshot_run = id + 1;
    byte snapshot_event = id + 1;
    byte snapshot_seed = id + 1;
    byte evidence_subject = id + 1;
    byte snapshot_approach = id;
    byte evidence_target = id + 1;
    byte proposal_target = id + 1;
    byte journal_key = id;
    bool frozen_trusted = true;
    bool patch_acknowledged;
    bool recovery_complete;

    phase[id] = Detected;
    /* One-failed-guard classes enumerate each mismatch, including an otherwise
     * internally consistent proposal/evidence pair for the other workload.
     * Admission is conjunctive: additional mismatches cannot admit a repair.
     * Evidence and proposal may exist before they are durably frozen; they
     * supply no MCP authority until the independent trusted freeze check.
     */
    if
    :: skip
    :: snapshot_run = 3 - source_run
    :: snapshot_event = 3 - source_event
    :: snapshot_seed = 3 - source_seed
    :: evidence_subject = 3 - source_seed
    :: snapshot_approach = 1 - id
    :: id == 1 -> frozen_trusted = false
    :: evidence_target = 3 - source_run; proposal_target = evidence_target
    :: proposal_target = 3 - source_run
    fi;
    /* Represents a completed assessed proposal. Internal assessment is not
     * an independent grant of controller authority. */
    phase[id] = Assessed;
    if
    :: !admission -> phase[id] = Rejected
    :: admission ->
        assert(snapshot_run == source_run && snapshot_event == source_event);
        assert(snapshot_seed == source_seed && evidence_subject == source_seed);
        assert(snapshot_approach == id);
        assert(id == 0 || frozen_trusted);
        assert(evidence_target == source_run && proposal_target == evidence_target);
#ifdef BUG_DUAL_JOURNAL
        journal_key = 0;
#endif
        /* Exact namespace/Deployment UID/original-template/policy keys map
         * these two distinct targets to two journals. Only the reservation
         * CAS is atomic. Live preflight/PATCH/recovery are later operations.
         */
        assert(journal_key == evidence_target - 1);
        atomic {
            assert(journal_source[journal_key] == 0);
            journal_source[journal_key] = source_run;
            phase[id] = Reserved
        };
        if
        :: patch_acknowledged = false
        :: patch_acknowledged = true;
           /* The executor's exact live UID/RV/template guards and API success
            * are abstracted by this accepted transition. */
           atomic {
               assert(journal_source[journal_key] == source_run);
               effects[evidence_target - 1]++;
               assert(effects[evidence_target - 1] <= 1);
               phase[id] = Applied
           }
        fi;
        if :: recovery_complete = false :: recovery_complete = true fi;
        if
        :: patch_acknowledged && recovery_complete -> phase[id] = Verified
        :: else -> skip
        fi
    fi;
    atomic { finished++ }
}

init {
    atomic { run Incident(0); run Incident(1) };
    finished == RUNS;
    assert(effects[0] <= 1 && effects[1] <= 1);
    assert(phase[0] != Verified || (effects[0] == 1 && journal_source[0] == 1));
    assert(phase[1] != Verified || (effects[1] == 1 && journal_source[1] == 2));
#ifdef WITNESS_DUAL_REPAIR
    assert(!(phase[0] == Verified && phase[1] == Verified));
#endif
}

ltl dual_repair_settles { <> (finished == RUNS) }
