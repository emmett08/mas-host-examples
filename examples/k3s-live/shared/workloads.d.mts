export interface ManagedWorkload {
  readonly namespace: 'mas-demo'; readonly name: string; readonly container: 'checkout';
  readonly approach: 'collected' | 'mcp'; readonly currentPath: '/readyz' | '/ready'; readonly proposedPath: '/healthz';
}
export const managedWorkloads: readonly ManagedWorkload[];
export function managedWorkload(namespace: unknown, name: unknown): ManagedWorkload | undefined;
