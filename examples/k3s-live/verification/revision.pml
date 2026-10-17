/* Example integration boundary: two exact candidates, one revision, one optional
 * controller action. Candidate content/hash equality and existing independent
 * remediation admission are Boolean abstractions. No diagnosis-quality claim. */
mtype = { Assessing, Completed, Exhausted, Cancelled, Blocked };
mtype outcome = Assessing;
byte candidate = 0;
byte selected = 255;
byte supplied_feedback = 255;
byte assessments = 0;
bool passed[2];
bool admission;
bool exact_selected = true;
bool mutation = false;
bool done = false;

active proctype Incident() {
    if :: admission = true :: admission = false fi;
    if
    :: outcome = Cancelled
    :: outcome = Blocked
    :: if :: passed[0] = true :: passed[0] = false fi;
       assessments++;
       if
       :: passed[0] -> outcome = Completed
       :: !passed[0] ->
          supplied_feedback = 0;
          candidate = 1;
          assert(supplied_feedback == candidate - 1);
          if :: passed[1] = true :: passed[1] = false fi;
          assessments++;
          if :: passed[1] -> outcome = Completed
             :: !passed[1] -> outcome = Exhausted fi
       fi
    fi;
    if
    :: (outcome == Completed || outcome == Exhausted) -> selected = candidate
    :: else -> skip
    fi;
    assert(candidate <= 1 && assessments <= 2);
#ifdef BUG_SELECTION
    exact_selected = false;
#endif
    /* Restart/display replay may repeat publication; it cannot select a new
     * output or run an effect. The controller separately admits one action. */
    if
    :: (outcome == Completed && admission) ->
       assert(selected == candidate && exact_selected);
       mutation = true
    :: else -> skip
    fi;
#ifdef BUG_AUTHORITY
    if :: outcome == Exhausted -> mutation = true :: else -> skip fi;
#endif
    assert(!mutation || (outcome == Completed && passed[selected] && admission));
#ifdef WITNESS_REVISION
    assert(!(candidate == 1 && mutation));
#endif
    done = true
}

ltl revision_settles { <> done }
