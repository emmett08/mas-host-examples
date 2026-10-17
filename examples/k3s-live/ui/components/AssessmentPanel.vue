<script setup lang="ts">
import { computed } from 'vue';
import type { RevisionAudit } from '../../shared/revision.mjs';

const props = defineProps<{ audit: RevisionAudit }>();
const evidence = computed(() => props.audit.records.filter(row => row.kind === 'evidence'));
const withheld = computed(() => props.audit.records.filter(row => row.redacted).length);
const display = (value: unknown) => JSON.stringify(value, null, 2);
const label = (kind: string) => kind === 'model' ? 'Model judgement' : 'Deterministic check';
const assessmentsFor = (id: string) => props.audit.assessments.filter(item => item.candidate.id === id);
</script>

<template>
  <section class="panel assessment-panel" aria-labelledby="assessment-title" :data-revision-status="audit.status">
    <div class="panel-heading">
      <div><span class="section-kicker">ASSESSMENT AND REVISION</span><h2 id="assessment-title">Which output was assessed?</h2></div>
      <span class="output-label">{{ audit.status.replaceAll('_', ' ') }}</span>
    </div>
    <div class="assessment-body">
      <p class="output-note">Internal checks evaluate the stated criteria. Diagnosis correctness, unsafe proposals and appropriate abstention require the separate held-out experiment. A higher internal score does not establish improvement.</p>
      <dl v-if="audit.budget" class="assessment-budget">
        <div><dt>Invocations reserved</dt><dd>{{ audit.budget.used_invocations }} / {{ audit.budget.max_invocations }}</dd></div>
        <div><dt>Maximum revisions</dt><dd>{{ audit.budget.max_revisions }}</dd></div>
        <div><dt>Selected candidate</dt><dd>{{ audit.selected?.id ?? 'Selection pending' }}</dd></div>
      </dl>
      <p v-if="audit.status === 'exhausted'" class="notice">The fixed budget ended. The selected candidate retains unresolved findings; selection is not a passing verdict.</p>
      <p v-if="withheld" class="payload-hidden">{{ withheld }} record(s) are withheld by the host's disclosure policy. Playback cannot recover omitted content.</p>
      <article v-for="candidate in audit.candidates" :key="candidate.id" class="candidate-card" :data-candidate-id="candidate.id" :data-selected="audit.selected?.id === candidate.id">
        <div class="candidate-heading"><h3>{{ candidate.id }}</h3><span class="kind-badge" :class="audit.selected?.id === candidate.id ? 'result' : 'other'">{{ audit.selected?.id === candidate.id ? 'Selected output' : candidate.parent ? 'Revision' : 'Original draft' }}</span></div>
        <p class="assessment-reference">Output SHA-256: <code>{{ candidate.output_sha256 }}</code></p>
        <p v-if="candidate.parent" class="assessment-reference">Revises <strong>{{ candidate.parent.id }}</strong> · record SHA-256 <code>{{ candidate.parent.sha256 }}</code></p>
        <p class="output-note">Supplied feedback: {{ candidate.feedback.length ? candidate.feedback.map(item => item.id).join(', ') : 'None' }}.</p>
        <details class="evidence-item"><summary>Exact candidate output</summary><pre>{{ display(candidate.output) }}</pre></details>
        <section v-for="assessment in assessmentsFor(candidate.id)" :key="assessment.id" class="criterion-assessment" :data-assessment-id="assessment.id">
          <div class="candidate-heading"><h4>{{ label(assessment.evaluator.kind) }} · {{ assessment.status }}</h4><span>{{ assessment.id }}</span></div>
          <p class="output-note">Evaluator {{ assessment.evaluator.id }} · {{ assessment.evaluator.version }}. Rubric {{ assessment.rubric.id }}.</p>
          <p class="assessment-reference">Assessed candidate <strong>{{ assessment.candidate.id }}</strong> · record SHA-256 <code>{{ assessment.candidate.sha256 }}</code></p>
          <p v-if="assessment.error" class="run-error">Evaluator error: {{ assessment.error }}. No passing verdict is available.</p>
          <div v-for="finding in assessment.findings" :key="finding.criterion_id" class="criterion-finding" :data-verdict="finding.verdict">
            <div class="candidate-heading"><strong>{{ finding.criterion_id }}</strong><span class="finding-verdict" :class="finding.verdict">{{ finding.verdict }}{{ finding.score === null ? ' · no measurement' : ` · score ${finding.score}` }}</span></div>
            <p>{{ finding.explanation }}</p>
            <ul class="assessment-evidence-links"><li v-for="item in finding.evidence" :key="item.id"><a :href="`#assessment-evidence-${item.id}`">{{ item.id }}</a><code>{{ item.sha256 }}</code></li></ul>
          </div>
        </section>
        <p v-if="!assessmentsFor(candidate.id).length" class="output-note">No assessment of this candidate has been retained in this observation.</p>
      </article>
      <details class="evidence-item">
        <summary>Supporting evidence records · {{ evidence.length }}</summary>
        <details v-for="row in evidence" :id="`assessment-evidence-${row.id}`" :key="row.id" class="evidence-item">
          <summary>{{ row.id }}{{ row.redacted ? ' · withheld' : '' }}</summary>
          <p class="assessment-reference">Record SHA-256: <code>{{ row.sha256 }}</code></p>
          <pre v-if="row.record">{{ display(row.record.content) }}</pre>
        </details>
      </details>
      <details class="evidence-item">
        <summary>Exact invocation inputs and disclosure policies · {{ audit.contexts.length }}</summary>
        <p class="output-note">Each retained input shows the evidence and feedback actually supplied to that invocation. An independent evaluator receives no peer assessment unless its frozen policy permits it. The guarantee covers host-mediated channels within the trusted-worker boundary.</p>
        <details v-for="context in audit.contexts" :key="context.id" class="evidence-item" :data-invocation-id="context.id">
          <summary>{{ context.actor }} · {{ context.id }}{{ context.redacted ? ' · withheld' : '' }}</summary>
          <template v-if="!context.redacted"><p class="payload-label">FROZEN POLICY</p><pre>{{ display(context.policy) }}</pre><p class="payload-label">SUPPLIED INPUT</p><pre>{{ display(context.input) }}</pre></template>
        </details>
      </details>
      <p class="evidence-limitation">This loop produces recommendations. The dedicated remediation controller independently applies its existing admission, identity, reservation and verification checks after the selected output is available.</p>
    </div>
  </section>
</template>
