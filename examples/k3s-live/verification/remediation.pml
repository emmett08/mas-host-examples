/* External deterministic remediation; MAS version 1 and hybrid.pml are unchanged.
 * One evidence bundle, proposal, target Deployment and invocation; at most one
 * patch effect. Booleans abstract exact identity/hash/policy comparisons, not
 * the truth of an LLM diagnosis. Each API call/poll has a finite response or
 * deadline failure. No crashes, retries, unbounded concurrent writers or timing
 * guarantee. A race is possible between the live GET and the atomic API patch.
 */
mtype = { Pending, NotAttempted, Rejected, PatchFailed, PatchUncertain, RecoveryFailed, Verified };
mtype outcome = Pending;
bool done = false;
bool remediation_enabled;
bool evidence_valid;
bool proposal_allowed;
bool namespace_uid_matches;
bool observed_target_present;
bool observed_uid_matches;
bool template_matches;
bool probe_matches;
bool patch_target_present;
bool patch_uid_matches;
bool resource_version_matches;
bool api_accepts;
bool patch_applied = false;
bool patch_acknowledged = false;
byte effects = 0;
bool recovery_identity_matches = false;
bool generation_observed = false;
bool rollout_ready = false;
bool replacement_pod_ready = false;
bool endpoint_200_body = false;
bool fresh_metrics = false;
bool report_authenticated;
bool report_published = false;

#define evidence_policy (remediation_enabled && evidence_valid && proposal_allowed)
#define target_preconditions (namespace_uid_matches && observed_target_present && observed_uid_matches && template_matches && probe_matches)
#define patch_identity (patch_target_present && patch_uid_matches)
#define recovered (recovery_identity_matches && generation_observed && rollout_ready && replacement_pod_ready && endpoint_200_body && fresh_metrics)

/* A UID-guard mutation removes both the live identity admission and the API
 * patch UID test. Removing only one leaves the other guard able to reject. */
#ifdef BUG_UID_GUARD
#define uid_admitted true
#define uid_patch_test true
#else
#define uid_admitted observed_uid_matches
#define uid_patch_test patch_uid_matches
#endif

#ifdef BUG_STALE_RV
#define rv_patch_test true
#else
#define rv_patch_test resource_version_matches
#endif

inline choose(value) { if :: value=true :: value=false fi }

active proctype Remediation() {
    /* These flags preserve all relevant observed acceptance/rejection classes.
     * Evidence includes collected status, subject UID and cited evidence IDs;
     * proposal includes the fixed namespace/name/container/path policy.
     * Current target checks include the managed label and unchanged full hash.
     */
    choose(remediation_enabled);
    choose(evidence_valid);
    choose(proposal_allowed);
    choose(namespace_uid_matches);
    choose(observed_target_present);
    choose(observed_uid_matches);
    choose(template_matches);
    choose(probe_matches);
    if
    :: !remediation_enabled -> outcome=NotAttempted
    :: remediation_enabled && !evidence_valid -> outcome=Rejected
    :: remediation_enabled && evidence_valid && !proposal_allowed -> outcome=NotAttempted
    :: remediation_enabled && evidence_valid && proposal_allowed ->
        if
        :: evidence_valid && namespace_uid_matches && observed_target_present && uid_admitted && template_matches && probe_matches ->
            /* External deletion/replacement and a new resourceVersion can
             * occur after admission. JSON Patch tests and the effect share
             * one API atomic operation; the earlier GET is not atomic with it.
             */
            choose(patch_target_present);
            choose(patch_uid_matches);
            choose(resource_version_matches);
            choose(api_accepts);
#ifdef BUG_REMEDIATION_STALL
            do :: patch_target_present -> skip :: break od;
#endif
            atomic {
                if
                :: patch_target_present && uid_patch_test && rv_patch_test && api_accepts ->
                    assert(evidence_policy && target_preconditions); /* APPLY_ONLY_ADMITTED_EVIDENCE_IDENTITY */
                    assert(patch_identity); /* API_UID_TEST_REJECTS_REPLACEMENT */
                    assert(resource_version_matches); /* API_RESOURCE_VERSION_TEST_REJECTS_RACE */
                    effects++;
                    assert(effects<=1); /* ONE_EFFECT_WITHIN_ONE_INVOCATION */
                    patch_applied=true
                :: !(patch_target_present && uid_patch_test && rv_patch_test && api_accepts) -> outcome=PatchFailed
                fi
            };
            if
            :: patch_applied ->
                /* The API may apply the effect but its response can be lost,
                 * time out or fail JSON decoding. The tool reports failure,
                 * does not retry and cannot declare verified recovery.
                 */
                choose(patch_acknowledged);
                if
                :: !patch_acknowledged -> outcome=PatchUncertain
                :: patch_acknowledged ->
                /* All partial recovery combinations are possible, including
                 * a Ready Deployment with missing/stale replacement metrics.
                 * Each flag summarises the bounded polling outcome, not one
                 * transient observation; false is deadline/error failure.
                 */
                choose(recovery_identity_matches);
                choose(generation_observed);
                choose(rollout_ready);
                choose(replacement_pod_ready);
                choose(endpoint_200_body);
                choose(fresh_metrics);
#ifdef BUG_EARLY_VERIFIED
                outcome=Verified;
#else
                if
                :: recovered -> outcome=Verified
                :: !recovered -> outcome=RecoveryFailed
                fi;
#endif
                assert(outcome!=Verified || (patch_applied && patch_acknowledged && recovered)); /* VERIFY_ONLY_OBSERVED_RECOVERY */
                assert(outcome!=Verified || effects==1)
                fi
            :: !patch_applied -> skip
            fi
        :: !(evidence_valid && namespace_uid_matches && observed_target_present && uid_admitted && template_matches && probe_matches) -> outcome=Rejected
        fi
    fi;
    assert(outcome!=Pending);
    assert(outcome!=Verified || (evidence_policy && target_preconditions && patch_identity && resource_version_matches && patch_applied && patch_acknowledged && recovered));
    assert(effects==0 || patch_applied);
    assert(!patch_applied || effects==1);
    /* Server publication authorises the external verifier's credential. This
     * models the acceptance decision, not credential secrecy or HTTP security.
     */
    choose(report_authenticated);
#ifdef BUG_REPORT_AUTH
    report_published=true;
#else
    if
    :: report_authenticated -> report_published=true
    :: !report_authenticated -> skip
    fi;
#endif
    assert(!report_published || report_authenticated); /* REPORT_REQUIRES_VERIFIER_CREDENTIAL */
    done=true;
#ifdef WITNESS_REMEDIATION_SUCCESS
    assert(outcome!=Verified); /* WITNESS_REACHABLE_VERIFIED_RECOVERY */
#endif
}

ltl remediation_settles { <> done }
