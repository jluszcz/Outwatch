// The bookkeeping behind `useRefreshGuard` (hooks.js), kept as a plain state
// machine so it can be unit-tested without a DOM or a renderer. It answers two
// questions and holds no data of its own:
//
//   - May this fetch's response be applied? Only the newest may. Focus and
//     visibilitychange often both fire, and a mutation starting mid-flight
//     invalidates whatever a fetch was already carrying.
//   - May this fetch start at all? Not while a mutation is in flight, because
//     its response could come from a read taken before the mutation commits.
//     Such a refresh is queued instead, and the last mutation to settle runs it.
export function createRefreshGuard() {
    let generation = 0;
    let fetchesInFlight = 0;
    let mutationsInFlight = 0;
    let queued = false;

    return {
        // A token to hand back to isCurrent(), or null when the fetch must not
        // start — it has been queued for the last mutation to run instead.
        startFetch() {
            if (mutationsInFlight > 0) {
                queued = true;
                return null;
            }
            fetchesInFlight++;
            return ++generation;
        },

        // True when this fetch is still the newest, so its response may apply.
        isCurrent(token) {
            return token === generation;
        },

        endFetch() {
            fetchesInFlight--;
        },

        beginMutation() {
            mutationsInFlight++;
            // A fetch already in flight may have read pre-mutation state: discard
            // its response and queue a refetch so the other-user changes it was
            // carrying still arrive.
            if (fetchesInFlight > 0) {
                generation++;
                queued = true;
            }
        },

        // True when this was the last mutation and a refresh is owed.
        endMutation() {
            if (--mutationsInFlight === 0 && queued) {
                queued = false;
                return true;
            }
            return false;
        },
    };
}
