import { keccak_256 } from '@noble/hashes/sha3';
import bs58 from 'bs58';

export interface RelayProtocolOrder {
  version: 'v1';
  solverChainId: string;
  solver: string;
  salt: string;
  inputs: Array<{
    payment: { chainId: string; currency: string; amount: string; weight: string };
    refunds: Array<{ chainId: string; recipient: string; currency: string; minimumAmount: string; deadline: number; extraData: string }>;
  }>;
  output: {
    chainId: string;
    payments: Array<{ recipient: string; currency: string; minimumAmount: string; expectedAmount: string }>;
    calls: string[];
    deadline: number;
    extraData: string;
  };
  fees: Array<{ recipientChainId: string; recipient: string; currencyChainId: string; currency: string; amount: string }>;
}

type Field = { name: string; type: string };
const TYPES: Record<string, Field[]> = {
  Order: [
    { name: 'version', type: 'string' }, { name: 'solverChainId', type: 'string' }, { name: 'solver', type: 'address' }, { name: 'salt', type: 'uint256' },
    { name: 'inputs', type: 'Input[]' }, { name: 'output', type: 'Output' }, { name: 'fees', type: 'Fee[]' },
  ],
  Input: [{ name: 'payment', type: 'InputPayment' }, { name: 'refunds', type: 'InputRefund[]' }],
  InputPayment: [{ name: 'chainId', type: 'string' }, { name: 'currency', type: 'bytes' }, { name: 'amount', type: 'uint256' }, { name: 'weight', type: 'uint256' }],
  InputRefund: [{ name: 'chainId', type: 'string' }, { name: 'recipient', type: 'bytes' }, { name: 'currency', type: 'bytes' }, { name: 'minimumAmount', type: 'uint256' }, { name: 'deadline', type: 'uint32' }, { name: 'extraData', type: 'bytes' }],
  Output: [{ name: 'chainId', type: 'string' }, { name: 'payments', type: 'OutputPayment[]' }, { name: 'deadline', type: 'uint32' }, { name: 'calls', type: 'bytes[]' }, { name: 'extraData', type: 'bytes' }],
  OutputPayment: [{ name: 'recipient', type: 'bytes' }, { name: 'currency', type: 'bytes' }, { name: 'minimumAmount', type: 'uint256' }, { name: 'expectedAmount', type: 'uint256' }],
  Fee: [{ name: 'recipientChainId', type: 'string' }, { name: 'recipient', type: 'bytes' }, { name: 'currencyChainId', type: 'string' }, { name: 'currency', type: 'bytes' }, { name: 'amount', type: 'uint256' }],
};

function bytes(value: string) {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new Error('invalid hex bytes');
  return Buffer.from(value.slice(2), 'hex');
}

function addressBytes(value: string, chainId: string) {
  if (chainId === 'solana') {
    const decoded = Buffer.from(bs58.decode(value));
    if (decoded.length !== 32) throw new Error('invalid Solana address');
    return decoded;
  }
  const decoded = bytes(value);
  if (decoded.length !== 20) throw new Error('invalid EVM address');
  return decoded;
}

function uint(value: string | number, bits: 32 | 256) {
  const integer = typeof value === 'number' ? BigInt(value) : BigInt(value);
  if (integer < 0n || integer >= 1n << BigInt(bits)) throw new Error('integer outside EIP-712 bounds');
  const hex = integer.toString(16).padStart(64, '0');
  return Buffer.from(hex, 'hex');
}

function hash(value: Uint8Array) { return Buffer.from(keccak_256(value)); }
function definition(name: string) { return `${name}(${TYPES[name].map((field) => `${field.type} ${field.name}`).join(',')})`; }
function typeHash(name: string) {
  const referenced = new Set<string>();
  const visit = (type: string) => {
    const base = type.replace(/\[\]$/, '');
    if (!TYPES[base] || base === name || referenced.has(base)) return;
    referenced.add(base); TYPES[base].forEach((field) => visit(field.type));
  };
  TYPES[name].forEach((field) => visit(field.type));
  return hash(Buffer.from(definition(name) + [...referenced].sort().map(definition).join(''), 'utf8'));
}

function encodeValue(type: string, value: unknown): Buffer {
  if (type.endsWith('[]')) {
    if (!Array.isArray(value)) throw new Error('invalid EIP-712 array');
    return hash(Buffer.concat(value.map((item) => encodeValue(type.slice(0, -2), item))));
  }
  if (TYPES[type]) {
    if (!value || typeof value !== 'object') throw new Error('invalid EIP-712 struct');
    return hashStruct(type, value as Record<string, unknown>);
  }
  if (type === 'string') return hash(Buffer.from(String(value), 'utf8'));
  if (type === 'bytes') return hash(Buffer.isBuffer(value) ? value : bytes(String(value)));
  if (type === 'address') { const raw = bytes(String(value)); if (raw.length !== 20) throw new Error('invalid EVM address'); return Buffer.concat([Buffer.alloc(12), raw]); }
  if (type === 'uint256') return uint(String(value), 256);
  if (type === 'uint32') return uint(Number(value), 32);
  throw new Error(`unsupported EIP-712 type ${type}`);
}

function hashStruct(type: string, value: Record<string, unknown>) {
  return hash(Buffer.concat([typeHash(type), ...TYPES[type].map((field) => encodeValue(field.type, value[field.name]))]));
}

function normalize(order: RelayProtocolOrder) {
  const encode = (value: string, chainId: string) => addressBytes(value, chainId);
  return {
    ...order,
    inputs: order.inputs.map((input) => ({
      payment: { ...input.payment, currency: encode(input.payment.currency, input.payment.chainId) },
      refunds: input.refunds.map((refund) => ({ ...refund, recipient: encode(refund.recipient, refund.chainId), currency: encode(refund.currency, refund.chainId) })),
    })),
    output: {
      ...order.output,
      payments: order.output.payments.map((payment) => ({ ...payment, recipient: encode(payment.recipient, order.output.chainId), currency: encode(payment.currency, order.output.chainId) })),
      calls: order.output.calls.map(bytes), extraData: bytes(order.output.extraData),
    },
    fees: order.fees.map((fee) => ({ ...fee, recipient: encode(fee.recipient, fee.recipientChainId), currency: encode(fee.currency, fee.currencyChainId) })),
  };
}

export function relayOrderId(order: RelayProtocolOrder) { return `0x${hashStruct('Order', normalize(order)).toString('hex')}`; }
