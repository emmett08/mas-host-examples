/* Application choreography; MAS wire version 1 is unchanged.
 * Durable request slots preserve messages after receipt; no lossy channel.
 * Eight invocations, seven actors, one run, two optional duplicate observer
 * reads. Each leaf has a finite success/failure response. Crashes, expiry,
 * cancellation, provider stalls, tokens and Kubernetes scheduling are excluded.
 * Atomic actions abstract one accepted send, receive or terminal operation;
 * this model does not establish refinement of the SQLite implementation.
 */
#define N 8
#define Client 0
#define Coordinator 1
#define Platform 2
#define Diagnose 3
#define Security 4
#define SecurityReview 5
#define Decision 6

#define allowed(a,b) (((a)==Client && (b)==Coordinator) || ((a)==Coordinator && (b)==Client) || ((a)==Coordinator && (b)==Platform) || ((a)==Platform && (b)==Coordinator) || ((a)==Coordinator && (b)==Security) || ((a)==Security && (b)==Coordinator) || ((a)==Platform && (b)==Diagnose) || ((a)==Diagnose && (b)==Platform) || ((a)==Platform && (b)==Security) || ((a)==Security && (b)==Platform) || ((a)==Security && (b)==SecurityReview) || ((a)==SecurityReview && (b)==Security) || ((a)==Coordinator && (b)==Decision) || ((a)==Decision && (b)==Coordinator))
#define closed(i) (state[i]==Succeeded || state[i]==Failed)
#define branches_complete (state[1]==Succeeded && state[2]==Succeeded)

mtype = { Absent, Sent, Received, Succeeded, Failed };
mtype state[N];
byte sender[N];
byte recipient[N];
byte reply_to[N];
byte dispatches = 0;
byte observer_reads = 0;
byte observed_dispatches = 0;
bool done = false;

inline dispatch(i) {
    assert(state[i]==Absent); /* UNIQUE_INVOCATION */
#ifdef BUG_ROUTE
    if :: i==4 -> recipient[i]=Decision :: else -> skip fi;
#endif
    assert(allowed(sender[i],recipient[i])); /* PERMITTED_REQUEST_ROUTE */
    if
    :: i==7 -> assert(branches_complete) /* DECISION_AFTER_BOTH_BRANCHES */
    :: else -> skip
    fi;
    state[i]=Sent;
    dispatches++;
    assert(dispatches<=N)
}

inline finish(i, outcome) {
    assert(state[i]==Received); /* TERMINAL_AFTER_CORRELATED_RECEIPT */
    reply_to[i]=i;
#ifdef BUG_CORRELATION
    if :: i==5 -> reply_to[i]=6 :: else -> skip fi;
#endif
    assert(reply_to[i]==i); /* TERMINAL_CORRELATES_EXACT_REQUEST */
    assert(allowed(recipient[i],sender[i])); /* PERMITTED_REPLY_ROUTE */
    state[i]=outcome
}

inline finish_child(parent, child) {
    if
    :: state[child]==Succeeded -> finish(parent,Succeeded)
    :: state[child]==Failed -> finish(parent,Failed)
    fi
}

active proctype Choreography() {
    byte i;
    atomic {
        i=0;
        do :: i<N -> state[i]=Absent; i++ :: else -> break od;
        sender[0]=Client; recipient[0]=Coordinator;
        sender[1]=Coordinator; recipient[1]=Platform;
        sender[2]=Coordinator; recipient[2]=Security;
        sender[3]=Platform; recipient[3]=Diagnose;
        sender[4]=Platform; recipient[4]=Security;
        sender[5]=Security; recipient[5]=SecurityReview;
        sender[6]=Security; recipient[6]=SecurityReview;
        sender[7]=Coordinator; recipient[7]=Decision;
        dispatch(0)
    }
    do
    /* A select/receive updates only its addressed durable slot. */
    :: atomic {
        state[0]==Sent -> state[0]=Received
    }
    :: atomic { state[1]==Sent -> state[1]=Received }
    :: atomic { state[2]==Sent -> state[2]=Received }
    :: atomic { state[3]==Sent -> state[3]=Received }
    :: atomic { state[4]==Sent -> state[4]=Received }
    :: atomic { state[5]==Sent -> state[5]=Received }
    :: atomic { state[6]==Sent -> state[6]=Received }
    :: atomic { state[7]==Sent -> state[7]=Received }

    /* The two coordinator branches can advance in either order. */
    :: atomic { state[0]==Received && state[1]==Absent -> dispatch(1) }
    :: atomic { state[0]==Received && state[2]==Absent -> dispatch(2) }
    :: atomic { state[1]==Received && state[3]==Absent -> dispatch(3) }
    :: atomic { state[1]==Received && state[3]==Failed -> finish(1,Failed) }
    :: atomic { state[1]==Received && state[3]==Succeeded && state[4]==Absent -> dispatch(4) }
    :: atomic { state[1]==Received && closed(4) -> finish_child(1,4) }
    :: atomic { state[2]==Received && state[5]==Absent -> dispatch(5) }
    :: atomic { state[2]==Received && closed(5) -> finish_child(2,5) }
    :: atomic { state[4]==Received && state[6]==Absent -> dispatch(6) }
    :: atomic { state[4]==Received && closed(6) -> finish_child(4,6) }

    /* The LLM response is abstracted to valid success or known failure. */
    :: atomic { state[3]==Received -> if :: finish(3,Succeeded) :: finish(3,Failed) fi }
    :: atomic { state[5]==Received -> if :: finish(5,Succeeded) :: finish(5,Failed) fi }
    :: atomic { state[6]==Received -> if :: finish(6,Succeeded) :: finish(6,Failed) fi }
    :: atomic { state[7]==Received -> if :: finish(7,Succeeded) :: finish(7,Failed) fi }

#ifdef BUG_EARLY_DECISION
    :: atomic { state[0]==Received && state[7]==Absent -> dispatch(7) }
#endif
    :: atomic { state[0]==Received && branches_complete && state[7]==Absent -> dispatch(7) }
    :: atomic { state[0]==Received && closed(1) && closed(2) && !branches_complete -> finish(0,Failed) }
    :: atomic { state[0]==Received && closed(7) -> finish_child(0,7) }

    /* Snapshot/replay has no receive, acknowledgement or admission action.
     * Two reads permit the same messages to be observed more than once. */
    :: atomic {
        observer_reads<2 ->
        observed_dispatches=dispatches;
#ifdef BUG_OBSERVER_DISPATCH
        dispatches++;
#endif
        observer_reads++;
        assert(observed_dispatches==dispatches) /* OBSERVATION_CANNOT_DISPATCH */
    }
#ifdef BUG_STALL
    :: state[3]==Received -> skip
#endif
    :: atomic {
        closed(0) ->
        assert(state[0]!=Succeeded || (branches_complete && state[7]==Succeeded));
        done=true;
#ifdef WITNESS_SUCCESS
        assert(state[0]!=Succeeded); /* REACH_SUCCESSFUL_HYBRID_JOIN */
#endif
        break
    }
    od
}

ltl choreography_settles { <> done }
