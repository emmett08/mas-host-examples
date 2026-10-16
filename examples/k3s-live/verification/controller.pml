/* Dedicated remediation controller; MAS version 1 is unchanged.
 * Two concurrent boot identities, two source Run UIDs, one retained journal
 * and one fault key (namespace UID, Deployment UID, original template hash,
 * policy version). Hash equality stands for exact comparison, not collision
 * resistance. Sources can share that fault key while retaining distinct UIDs.
 *
 * Only Kubernetes create/status CAS and the atomic guarded workload PATCH are
 * atomic. Claim acknowledgement, patch effect, patch response, recovery and
 * durable terminal publication are separate crash points. Applying never
 * returns to Pending. A deadline may terminalise even a delayed live owner;
 * that owner can still finish its one already-reserved effect but cannot
 * overwrite or publish a contradictory terminal report. The journal is never
 * deleted in this model. Freshness is the admission check result, not elapsed
 * time between validation and PATCH. No storage loss or credential adversary
 * is modelled. Pure preflight/no-action returns have no mutation or journal;
 * this model covers mutation-bearing reports and their durable outbox.
 */
mtype = { Missing, Pending, Applying, Finished, NoReport, Verified, Failed, Uncertain };
mtype phase = Missing;
mtype durable_report = NoReport;
mtype first_report = NoReport;
byte resource_version = 0;
byte journal_source = 0;
byte owner = 0;
byte source_uid[2];
byte effects = 0;
byte workers_done = 0;
byte publications = 0;
byte first_published_source = 0;
mtype first_published_report = NoReport;
bool original_claim_ack[2];
bool lost_create_ack[2];
bool effect_by[2];
bool patch_ack[2];
bool recovery_complete[2];
bool expired = false;
bool expiry_done = false;
bool publisher_done = false;
bool controller_enabled = true;
bool source_bound = true;
bool evidence_fresh = true;
bool evidence_valid = true;
bool policy_allowed = true;
bool target_identity_matches = true;

#ifdef BUG_SOURCE_BINDING
#define source_test true
#else
#define source_test source_bound
#endif
#ifdef BUG_STALE_EVIDENCE
#define freshness_test true
#else
#define freshness_test evidence_fresh
#endif
#define source_admission (controller_enabled && source_test && freshness_test)
#define admission (source_admission && evidence_valid && policy_allowed && target_identity_matches)
#define true_admission (controller_enabled && source_bound && evidence_fresh && evidence_valid && policy_allowed && target_identity_matches)

inline choose(value) { if :: value=true :: value=false fi }

inline finish(result) {
    /* An accepted status CAS commits canonical report bytes atomically. The
     * report enum abstracts those immutable bytes. A missing response never
     * permits substitution of a local report; an outbox read uses this value.
     */
    assert(durable_report==NoReport); /* FIRST_TERMINAL_WINS */
    durable_report=result;
    first_report=result;
    phase=Finished;
    resource_version++
}

proctype Worker(byte id) {
    mtype seen_phase;
    byte seen_version;
    bool create_ok = false;
    bool create_ack;
    bool reserved = false;
    bool crashed = false;
    bool api_accepts;
    bool patch_tests;
    bool patch_response;
    bool all_recovery;
    bool finish_ack;
    bool fresh_after_claim;

    if
    :: admission -> skip
    :: !admission -> goto stop
    fi;
    /* Observe and CAS are deliberately separate. Either worker may read
     * Missing, lose create with 409, or race after reading Pending.
     */
    atomic { seen_phase=phase; seen_version=resource_version };
    if
    :: seen_phase==Missing ->
        atomic {
            if
            :: phase==Missing && resource_version==seen_version ->
                phase=Pending; journal_source=source_uid[id]; resource_version++;
                create_ok=true
            :: else -> create_ok=false
            fi
        };
        if
        :: !create_ok -> goto stop /* create 409: no effect in this pass */
        :: create_ok ->
            /* An accepted create with a lost response also aborts this pass.
             * The retained Pending record can be re-admitted by a later pass.
             */
            choose(create_ack);
            lost_create_ack[id]=!create_ack;
            if
#ifdef BUG_LOST_CREATE_ACK
            :: true -> atomic { seen_phase=phase; seen_version=resource_version }
#else
            :: create_ack -> atomic { seen_phase=phase; seen_version=resource_version }
            :: !create_ack -> goto stop
#endif
            fi
        fi
    :: seen_phase!=Missing -> skip
    fi;
    if
    :: journal_source!=source_uid[id] -> goto stop /* same fault, different Run */
    :: journal_source==source_uid[id] -> skip
    fi;
    if
    :: seen_phase==Pending ->
        atomic {
            if
#ifdef BUG_CAS_BYPASS
            :: phase==Pending || phase==Applying ->
#else
            :: phase==Pending && resource_version==seen_version ->
#endif
                phase=Applying; owner=id+1; resource_version++;
                /* Claim commits even if its response is lost. Only a real
                 * successful response grants this process effect authority.
                 */
                choose(original_claim_ack[id]);
                reserved=original_claim_ack[id]
            :: else -> reserved=false /* claim 409: no effect */
            fi
        }
    :: seen_phase==Applying ->
#ifdef BUG_RETRY_APPLYING
        reserved=true /* defective retry treats observed Applying as a grant */
#else
        reserved=false
#endif
    :: else -> reserved=false
    fi;
    if
    :: !reserved -> goto stop
    :: reserved -> skip
    fi;
    /* The hook checks evidence age once more after its claim ACK. A failed
     * post-ACK check leaves Applying uncertain and produces no effect.
     */
    choose(fresh_after_claim);
    if :: !fresh_after_claim -> goto stop :: fresh_after_claim -> skip fi;
    /* A crash before the effect leaves Applying; subsequent owners close it
     * as uncertain instead of claiming it again. Later crash points have the
     * same recovery rule but different actual cluster state.
     */
    choose(crashed);
    if :: crashed -> goto stop :: !crashed -> skip fi;
    choose(api_accepts);
    choose(patch_tests);
    atomic {
        assert(original_claim_ack[id]); /* ACKNOWLEDGED_ORIGINAL_RESERVATION */
        assert(!lost_create_ack[id]); /* LOST_CREATE_ACK_STOPS_THIS_PASS */
        assert(journal_source==source_uid[id]); /* EFFECT_BINDS_IMMUTABLE_SOURCE_RUN */
        assert(controller_enabled && source_bound); /* SOURCE_AND_ENABLEMENT_BOUND */
        assert(evidence_fresh && fresh_after_claim); /* FRESH_EVIDENCE_BEFORE_EFFECT */
        assert(true_admission);
        if
        :: api_accepts && patch_tests ->
            effects++; effect_by[id]=true;
            assert(effects<=1) /* ONE_EFFECT_PER_RETAINED_FAULT_JOURNAL */
        :: !(api_accepts && patch_tests) -> skip
        fi
    };
    choose(crashed);
    if :: crashed -> goto stop :: !crashed -> skip fi;
    /* A lost response after an effect never becomes acknowledged success. */
    choose(patch_response);
    patch_ack[id]=(effect_by[id] && patch_response);
    choose(crashed);
    if :: crashed -> goto stop :: !crashed -> skip fi;
    /* All combinations of generation/rollout, exact owner chain, replacement
     * Ready/no restarts, endpoint body and fresh replacement metrics collapse
     * to their conjunction: no partial combination authorises verification.
     * remediation.pml separately enumerates each recovery predicate.
     */
    choose(all_recovery);
    recovery_complete[id]=(patch_ack[id] && all_recovery);
    choose(crashed);
    if :: crashed -> goto stop :: !crashed -> skip fi;
#ifdef BUG_EARLY_PUBLISH
    assert(phase==Finished); /* DURABLE_TERMINAL_PRECEDES_PUBLICATION */
#endif
    atomic {
        if
        :: phase==Applying && owner==id+1 ->
            if
            :: patch_ack[id] && recovery_complete[id] -> finish(Verified)
            :: !(patch_ack[id] && recovery_complete[id]) -> finish(Failed)
            fi;
            assert(durable_report!=Verified || (original_claim_ack[id] && effect_by[id] && patch_ack[id] && recovery_complete[id]));
            /* Terminal write ACK may be lost; its stored bytes still win. */
            choose(finish_ack)
        :: else -> skip /* expiry's terminal wins; discard local report */
        fi
    };
stop:
    atomic { workers_done++ }
}

proctype Expiry() {
    do
    :: phase==Applying ->
#ifdef BUG_CONTROLLER_STALL
        do :: phase==Applying -> skip :: phase!=Applying -> break od;
#endif
        atomic {
            if
            :: phase==Applying -> expired=true; finish(Uncertain)
            :: else -> skip
            fi
        };
        break
    :: phase==Finished -> break
    :: workers_done==2 && phase!=Applying -> break
    od;
    expiry_done=true
}

proctype Outbox() {
    byte attempt=0;
    bool authenticated;
    bool response_ack;
    do
    :: phase==Finished -> break
    :: workers_done==2 && expiry_done && phase!=Applying -> goto settled
    od;
    /* Two bounded publication attempts model retry after lost POST responses
     * and restart. They never visit Worker or the workload PATCH again.
     */
    do
    :: attempt<2 ->
        attempt++;
        choose(authenticated);
        choose(response_ack);
        if
        :: authenticated ->
            atomic {
                assert(phase==Finished && durable_report!=NoReport);
                assert(durable_report==first_report); /* IMMUTABLE_DURABLE_REPORT */
                if
                :: publications==0 ->
                    first_published_report=durable_report;
                    first_published_source=journal_source
                :: else ->
                    assert(durable_report==first_published_report && journal_source==first_published_source)
                fi;
                publications++;
                if
                :: durable_report==Verified ->
                    assert(!expired && effects==1);
                    assert((effect_by[0] && original_claim_ack[0] && patch_ack[0] && recovery_complete[0]) || (effect_by[1] && original_claim_ack[1] && patch_ack[1] && recovery_complete[1]))
                :: else -> skip
                fi
            }
        :: !authenticated -> skip
        fi
    :: attempt==2 -> break
    od;
settled:
    publisher_done=true
}

init {
    byte rejection_class;
    /* Single-failed-guard equivalence classes cover each rejection family.
     * Source or executor rejection occurs before lazy journal creation. Those
     * pure preflight no-effect reports are outside the durable effect outbox.
     * Additional false guards cannot admit an effect: admission is conjunctive.
     */
    atomic {
        if
        :: rejection_class=0
        :: rejection_class=1; controller_enabled=false
        :: rejection_class=2; source_bound=false
        :: rejection_class=3; evidence_fresh=false
        :: rejection_class=4; evidence_valid=false
        :: rejection_class=5; policy_allowed=false
        :: rejection_class=6; target_identity_matches=false
        fi;
        source_uid[0]=1;
        if :: source_uid[1]=1 :: source_uid[1]=2 fi;
        run Worker(0); run Worker(1); run Expiry(); run Outbox()
    };
    workers_done==2 && expiry_done && publisher_done;
    assert(effects<=1);
    assert(phase!=Applying);
    assert(durable_report==NoReport || durable_report==first_report);
#ifdef WITNESS_CONTROLLER_SUCCESS
    assert(durable_report!=Verified); /* WITNESS_DURABLE_VERIFIED_REACHABLE */
#endif
#ifdef WITNESS_CONTROLLER_UNCERTAINTY
    assert(!(expired && effects==1 && durable_report==Uncertain)); /* WITNESS_EFFECT_WITH_UNCERTAIN_TERMINAL */
#endif
}

ltl controller_settles { <> (workers_done==2 && expiry_done && publisher_done && phase!=Applying) }
