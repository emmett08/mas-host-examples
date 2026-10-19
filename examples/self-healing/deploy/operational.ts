import { sha256, RejectedEffect } from './effects.js';
import type { KubernetesTransport } from './trial.js';

export interface OperationalTargetGrant {
  namespace: string; deployment: string; deploymentUid: string; container: string;
  pod: string; podUid: string; imageDigest: string; sourceCommit: string;
  /** Engineer-controlled release metadata installed by the build/deploy interface. */
  sourceAnnotation: string;
  configurationSha256?: string;
  /** Complete credential-free application env copied into isolated matched trials. */
  runtimeEnvironment?: Record<string, string>;
  event?: { name: string; uid: string };
}
export interface OperationalBinding {
  namespace: string; deployment: string; deploymentUid: string; resourceVersion: string;
  pod: string; podUid: string; replicaSetUid: string; imageDigest: string; imageId: string;
  sourceCommit: string; sourceAnnotation: string; configurationSha256: string;
  podConfigurationSha256: string; runtimeEnvironmentSha256: string;
  releaseGeneration: number; observedAt: string;
  trigger: { kind: 'manual'; subjectUid: string } | { kind: 'kubernetes-event'; uid: string; subjectUid: string; reason: string; type: string };
}
function safeName(name: unknown): boolean { return typeof name === 'string' && /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(name); }
function validate(grant: OperationalTargetGrant): void {
  if (![grant.namespace, grant.deployment, grant.pod, grant.container].every(safeName)
    || typeof grant.deploymentUid !== 'string' || !grant.deploymentUid || typeof grant.podUid !== 'string' || !grant.podUid || !/^[\w./:-]+@sha256:[a-f0-9]{64}$/.test(grant.imageDigest)
    || !/^[a-f0-9]{40}$/.test(grant.sourceCommit) || !/^[A-Za-z0-9_.\/-]{1,253}$/.test(grant.sourceAnnotation)
    || (grant.configurationSha256 !== undefined && !/^[a-f0-9]{64}$/.test(grant.configurationSha256))
    || (grant.event && (!safeName(grant.event.name) || !grant.event.uid))) throw new RejectedEffect('Exact admitted operational target/release identities required');
  if (Object.entries(grant.runtimeEnvironment ?? {}).some(([name, value]) => !/^[A-Z][A-Z0-9_]*$/.test(name)
    || /TOKEN|SECRET|PASSWORD|CREDENTIAL|KUBECONFIG|DOCKER|AWS_|OPENAI|GITHUB|LD_|NODE_OPTIONS|PATH|HOME/i.test(name)
    || typeof value !== 'string' || value.length > 2000)) throw new RejectedEffect('Operational environment exceeds the credential-free trial boundary');
}
/** Read-only source→release→Pod binding. It cannot mutate an operational workload.
 * The source annotation is a deployment-interface assertion, not proof of build correctness.
 * Actual image manifests and independent build receipts must support that assertion. */
export async function observeOperationalTarget(kube: KubernetesTransport, grant: OperationalTargetGrant,
  previous?: OperationalBinding): Promise<OperationalBinding> {
  validate(grant);
  const [deployment, pod] = await Promise.all([
    kube.get('deployment', grant.deployment, grant.namespace), kube.get('pod', grant.pod, grant.namespace),
  ]);
  if (!deployment || !pod || deployment.metadata?.uid !== grant.deploymentUid || pod.metadata?.uid !== grant.podUid
    || deployment.metadata?.namespace !== grant.namespace || pod.metadata?.namespace !== grant.namespace
    || typeof deployment.metadata.resourceVersion !== 'string' || !Number.isSafeInteger(deployment.metadata.generation) || deployment.metadata.generation < 1) throw new RejectedEffect('Operational deployment or Pod identity changed');
  const owners = (pod.metadata.ownerReferences ?? []).filter((owner: any) => owner.controller === true);
  if (owners.length !== 1 || owners[0].kind !== 'ReplicaSet' || !safeName(owners[0].name)) throw new RejectedEffect('Pod lacks the admitted Deployment ownership path');
  // This one dependent metadata read is authorised by the exact admitted Pod's controller reference.
  const replicaSet = await kube.get('replicaset', owners[0].name, grant.namespace);
  const deploymentOwners = (replicaSet?.metadata?.ownerReferences ?? []).filter((owner: any) => owner.controller === true);
  if (!replicaSet || replicaSet.metadata.uid !== owners[0].uid || deploymentOwners.length !== 1
    || deploymentOwners[0].kind !== 'Deployment' || deploymentOwners[0].uid !== grant.deploymentUid || deploymentOwners[0].name !== grant.deployment)
    throw new RejectedEffect('Pod belongs to another release controller');
  const selected = (items: any[]) => items?.filter(item => item.name === grant.container) ?? [];
  for (const spec of [deployment.spec?.template?.spec, pod.spec]) {
    if (spec?.containers?.length !== 1 || spec.initContainers?.length || spec.ephemeralContainers?.length || spec.volumes?.length
      || spec.hostNetwork || spec.hostPID || spec.hostIPC) throw new RejectedEffect('Operational workload exceeds the single-process stateless isolated adapter');
  }
  const deployedContainers = selected(deployment.spec?.template?.spec?.containers), runningContainers = selected(pod.spec?.containers);
  const statuses = selected(pod.status?.containerStatuses);
  if (deployedContainers.length !== 1 || runningContainers.length !== 1 || statuses.length !== 1
    || deployedContainers[0].image !== grant.imageDigest || runningContainers[0].image !== grant.imageDigest
    || String(statuses[0].imageID).match(/sha256:[a-f0-9]{64}/)?.[0] !== grant.imageDigest.split('@')[1]) throw new RejectedEffect('Configured release and actual Pod image differ');
  for (const container of [deployedContainers[0], runningContainers[0]]) {
    if (container.envFrom?.length || container.command?.length || container.args?.length || container.volumeMounts?.length
      || (container.workingDir && container.workingDir !== '/app')) throw new RejectedEffect('Operational process or mounted-data configuration requires an explicit isolated adapter');
    const environment: Record<string, string> = {};
    for (const entry of container.env ?? []) {
      if (typeof entry.value !== 'string' || entry.valueFrom || Object.hasOwn(environment, entry.name)) throw new RejectedEffect('Operational external environment cannot be reproduced in this credential-free trial');
      environment[entry.name] = entry.value;
    }
    if (sha256(environment) !== sha256(grant.runtimeEnvironment ?? {})) throw new RejectedEffect('Admitted isolated runtime environment does not match the deployed application');
  }
  const declaredSource = deployment.spec?.template?.metadata?.annotations?.[grant.sourceAnnotation];
  const podSource = pod.metadata?.annotations?.[grant.sourceAnnotation];
  if (declaredSource !== grant.sourceCommit || podSource !== grant.sourceCommit) throw new RejectedEffect('Source-to-release provenance annotation missing or changed');
  // Hash complete declared workload configuration. Never return env values, secrets or volume contents.
  const configurationSha256 = sha256(deployment.spec.template.spec);
  if (grant.configurationSha256 && configurationSha256 !== grant.configurationSha256) throw new RejectedEffect('Operational workload configuration changed');
  let trigger: OperationalBinding['trigger'] = { kind: 'manual', subjectUid: grant.podUid };
  if (grant.event) {
    const event = await kube.get('event', grant.event.name, grant.namespace);
    if (!event || event.metadata?.uid !== grant.event.uid || ![grant.podUid, grant.deploymentUid].includes(event.involvedObject?.uid)) throw new RejectedEffect('Trigger does not identify the admitted Pod or release');
    trigger = { kind: 'kubernetes-event', uid: event.metadata.uid, subjectUid: event.involvedObject.uid,
      reason: String(event.reason ?? '').slice(0, 100), type: String(event.type ?? '').slice(0, 40) };
  }
  const observed: OperationalBinding = { namespace: grant.namespace, deployment: grant.deployment, deploymentUid: grant.deploymentUid,
    resourceVersion: deployment.metadata.resourceVersion, pod: grant.pod, podUid: grant.podUid, replicaSetUid: replicaSet.metadata.uid,
    imageDigest: grant.imageDigest, imageId: statuses[0].imageID, sourceCommit: grant.sourceCommit, sourceAnnotation: grant.sourceAnnotation,
    configurationSha256, podConfigurationSha256: sha256(pod.spec), runtimeEnvironmentSha256: sha256(grant.runtimeEnvironment ?? {}),
    releaseGeneration: deployment.metadata.generation, observedAt: new Date().toISOString(), trigger };
  if (previous) {
    const release = (value: OperationalBinding) => ({ namespace: value.namespace, deployment: value.deployment, deploymentUid: value.deploymentUid,
      pod: value.pod, podUid: value.podUid, replicaSetUid: value.replicaSetUid, imageDigest: value.imageDigest, sourceCommit: value.sourceCommit,
      sourceAnnotation: value.sourceAnnotation, configurationSha256: value.configurationSha256, podConfigurationSha256: value.podConfigurationSha256,
      runtimeEnvironmentSha256: value.runtimeEnvironmentSha256, releaseGeneration: value.releaseGeneration });
    // ResourceVersion can advance due solely to status changes. The complete declared config
    // and generation, exact Pod and owner chain must remain unchanged before publication.
    if (sha256(release(observed)) !== sha256(release(previous))) throw new RejectedEffect('Operational release changed since the incident was bound');
  }
  return observed;
}
