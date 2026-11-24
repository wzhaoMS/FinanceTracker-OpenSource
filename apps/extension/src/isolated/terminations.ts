/** How a stopped `bankRead` is reported: as a coverage termination and as a collector code. */
import type { CardSyncTermination } from '@finance-tracker/shared';
import type { CollectorCode } from '../contracts/messages.js';
import type { BankReadError } from './bankRead.js';

export function terminationFor(error: BankReadError): CardSyncTermination {
  switch (error) {
    case 'auth-required':
      return 'auth-required';
    case 'rate-limited':
      return 'rate-limited';
    case 'cap':
    case 'too-large':
      return 'cap';
    case 'repeated-cursor':
      return 'repeated-cursor';
    case 'stopped':
      return 'user-navigation';
    default:
      return 'error';
  }
}

export function codeFor(error: BankReadError): CollectorCode {
  switch (error) {
    case 'auth-required':
      return 'auth-required';
    case 'rate-limited':
      return 'rate-limited';
    case 'cap':
      return 'read-cap';
    case 'too-large':
      return 'too-large';
    case 'repeated-cursor':
      return 'repeated-cursor';
    case 'timeout':
      return 'timeout';
    case 'stopped':
      return 'stopped';
    case 'unexpected-response':
      return 'unexpected-response';
    default:
      return 'read-failed';
  }
}
