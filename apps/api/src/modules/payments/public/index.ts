/** Public surface of the payments module. Other modules and the app shell import ONLY from here. */
export { PaymentsModule } from '../payments.module.js';
export { PAYMENTS_PORT, PaymentsFacade } from '../payments.port.js';
export type { CheckPaymentSummary, PaymentsPort } from '../payments.port.js';
export { ORDER_PORT, SqlOrderPortStub } from '../ports/order.port.js';
export type { CheckForPayment, OrderPort, PaymentAggregate } from '../ports/order.port.js';
export { EnvPaymentSecrets, PAYMENT_SECRETS, StaticPaymentSecrets } from '../ports/secrets.port.js';
export type { PaymentSecretsPort } from '../ports/secrets.port.js';
export {
  PROVIDER_REGISTRY,
  ProviderRegistry,
  defaultProviderRegistry,
} from '../providers/provider-registry.js';
export { SweepersService } from '../sweepers.service.js';
export type { SweepSummary } from '../sweepers.service.js';
export { EXECUTION_FAULTS } from '../execution.service.js';
export type { ExecutionFaults } from '../execution.service.js';
export { REFUND_FAULTS } from '../refunds.service.js';
export type { RefundFaults } from '../refunds.service.js';
export {
  PAYMENTS_CONFIG,
  PAYMENTS_CONFIG_DEFAULTS,
  paymentsConfigFromEnv,
} from '../payments.config.js';
export type { PaymentsConfig } from '../payments.config.js';
export { assertTransition, canTransition, TRANSITIONS } from '../domain/state-machine.js';
