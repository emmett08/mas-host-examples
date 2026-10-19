/** Forward cancellation committed by another trusted process to the active runtime signal. */
import type { Journal } from './journal.js';
export function watchCancellation(journal: Journal, controller: AbortController): () => void {
  const poll = () => { if (journal.isCancelled() && !controller.signal.aborted) controller.abort(); };
  poll();
  const timer = setInterval(poll, 100);
  return () => clearInterval(timer);
}
