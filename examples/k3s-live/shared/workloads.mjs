// Fixed demonstration policies. Neither model output nor labels can add targets.
export const managedWorkloads = Object.freeze([
  Object.freeze({ namespace: 'mas-demo', name: 'mas-demo-checkout', container: 'checkout',
    approach: 'collected', currentPath: '/readyz', proposedPath: '/healthz' }),
  Object.freeze({ namespace: 'mas-demo', name: 'mas-demo-checkout-mcp', container: 'checkout',
    approach: 'mcp', currentPath: '/ready', proposedPath: '/healthz' }),
]);
export function managedWorkload(namespace, name) {
  return managedWorkloads.find(workload => workload.namespace === namespace && workload.name === name);
}
