export function mergeDiscovery(draft, requested, candidate) {
  if (
    !candidate ||
    draft.checkout !== requested.checkout ||
    draft.repositoryUrl !== requested.repositoryUrl
  )
    return draft;
  return {
    ...draft,
    checkout: candidate.checkout,
    repositoryUrl: candidate.repositoryUrl ?? draft.repositoryUrl,
  };
}
