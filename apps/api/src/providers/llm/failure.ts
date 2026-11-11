import type { ServiceError } from '@assistant/contracts';

export class ServiceFailure extends Error {
  constructor(readonly code: ServiceError) {
    super(code);
  }
}
