// One per-constituent write lock shared by every write service, so a name
// update and an address update can never overlap on the same constituent
// between their stale check and their verifying re-read.
export const constituentLocks = new Set();
