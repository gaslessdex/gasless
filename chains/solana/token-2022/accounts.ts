import {
  AccountState,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  getAccountLen,
  getDefaultAccountState,
  getExtensionData,
  getExtensionTypes,
  getMetadataPointerState,
  getPausableConfig,
  getPermanentDelegate,
  getScaledUiAmountConfig,
  getTransferHook,
  amountToUiAmountForScaledUiAmountMintWithoutSimulation,
  uiAmountToAmountForScaledUiAmountMintWithoutSimulation,
  unpackAccount,
  unpackMint,
} from '@solana/spl-token';
import { PublicKey, type AccountInfo } from '@solana/web3.js';
import type { RpcAccountInfo } from '../../../server/solana/rpc.js';
import { TOKEN_2022_PROGRAM } from '../token-registry/types.js';

export const XSTOCK_MINT_EXTENSIONS = [
  'ConfidentialTransferMint',
  'DefaultAccountState',
  'PermanentDelegate',
  'TransferHook',
  'MetadataPointer',
  'TokenMetadata',
  'ScaledUiAmount',
  'Pausable',
] as const;

export const XSTOCK_TOKEN_ACCOUNT_EXTENSIONS = ['ImmutableOwner', 'TransferHookAccount', 'PausableAccount'] as const;

const extensionName = (extension: ExtensionType) => extension === ExtensionType.ScaledUiAmountConfig
  ? 'ScaledUiAmount'
  : extension === ExtensionType.PausableConfig
    ? 'Pausable'
    : ExtensionType[extension] ?? `UnknownExtension(${extension})`;
const publicKey = (value: PublicKey | null | undefined) => value?.equals(PublicKey.default) ? null : value?.toBase58() ?? null;

function web3AccountInfo(account: RpcAccountInfo): AccountInfo<Buffer> {
  if (account.data[1] !== 'base64') throw new Error('Token account data is not base64 encoded.');
  return {
    data: Buffer.from(account.data[0], 'base64'),
    executable: account.executable,
    lamports: account.lamports,
    owner: new PublicKey(account.owner),
    rentEpoch: account.rentEpoch,
  };
}

export interface Token2022MintProfile {
  address: string;
  accountSize: number;
  tokenAccountSize: number;
  decimals: number;
  supplyRaw: string;
  initialized: boolean;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  extensions: string[];
  transferHook: { authority: string | null; programId: string | null } | null;
  metadataPointer: { authority: string | null; metadataAddress: string | null } | null;
  permanentDelegate: string | null;
  defaultAccountState: 'INITIALIZED' | 'FROZEN' | 'UNINITIALIZED' | null;
  pausable: { authority: string | null; paused: boolean } | null;
  scaledUiAmount: { authority: string | null; multiplier: number; newMultiplierEffectiveTimestamp: string; newMultiplier: number } | null;
  confidentialTransferMint: { authority: string | null; autoApproveNewAccounts: boolean; auditorElgamalPubkeyHex: string | null } | null;
}

export interface Token2022AccountProfile {
  address: string;
  accountSize: number;
  mint: string;
  owner: string;
  amountRaw: string;
  initialized: boolean;
  frozen: boolean;
  native: boolean;
  delegate: string | null;
  delegatedAmountRaw: string;
  closeAuthority: string | null;
  extensions: string[];
}

function parseOptionalNonZeroPubkey(data: Buffer, offset: number) {
  const bytes = data.subarray(offset, offset + 32);
  return bytes.length === 32 && bytes.some((byte) => byte !== 0) ? new PublicKey(bytes).toBase58() : null;
}

export function parseToken2022Mint(address: string, account: RpcAccountInfo): Token2022MintProfile {
  if (account.owner !== TOKEN_2022_PROGRAM || account.executable) throw new Error('Mint is not a Token-2022 data account.');
  const mint = unpackMint(new PublicKey(address), web3AccountInfo(account), TOKEN_2022_PROGRAM_ID);
  const types = getExtensionTypes(mint.tlvData);
  const hook = getTransferHook(mint);
  const metadata = getMetadataPointerState(mint);
  const delegate = getPermanentDelegate(mint);
  const defaultState = getDefaultAccountState(mint)?.state;
  const pausable = getPausableConfig(mint);
  const scaled = getScaledUiAmountConfig(mint);
  const confidential = getExtensionData(ExtensionType.ConfidentialTransferMint, mint.tlvData);
  const accountExtensions = [
    ExtensionType.ImmutableOwner,
    ...(types.includes(ExtensionType.TransferFeeConfig) ? [ExtensionType.TransferFeeAmount] : []),
    ...(types.includes(ExtensionType.NonTransferable) ? [ExtensionType.NonTransferableAccount] : []),
    ...(types.includes(ExtensionType.TransferHook) ? [ExtensionType.TransferHookAccount] : []),
    ...(types.includes(ExtensionType.PausableConfig) ? [ExtensionType.PausableAccount] : []),
  ];
  return {
    address,
    accountSize: accountData(account).length,
    // ConfidentialTransferAccount is opt-in, not required on ordinary ATAs. The
    // ATA program always adds ImmutableOwner and initializes only required
    // account-side counterparts for the mint's transaction-semantic extensions.
    tokenAccountSize: getAccountLen(accountExtensions),
    decimals: mint.decimals,
    supplyRaw: mint.supply.toString(),
    initialized: mint.isInitialized,
    mintAuthority: publicKey(mint.mintAuthority),
    freezeAuthority: publicKey(mint.freezeAuthority),
    extensions: types.map(extensionName),
    transferHook: hook ? { authority: publicKey(hook.authority), programId: publicKey(hook.programId) } : null,
    metadataPointer: metadata ? { authority: publicKey(metadata.authority), metadataAddress: publicKey(metadata.metadataAddress) } : null,
    permanentDelegate: publicKey(delegate?.delegate),
    defaultAccountState: defaultState === undefined ? null : defaultState === AccountState.Initialized ? 'INITIALIZED' : defaultState === AccountState.Frozen ? 'FROZEN' : 'UNINITIALIZED',
    pausable: pausable ? { authority: publicKey(pausable.authority), paused: pausable.paused } : null,
    scaledUiAmount: scaled ? { authority: publicKey(scaled.authority), multiplier: scaled.multiplier, newMultiplierEffectiveTimestamp: scaled.newMultiplierEffectiveTimestamp.toString(), newMultiplier: scaled.newMultiplier } : null,
    confidentialTransferMint: confidential ? {
      authority: parseOptionalNonZeroPubkey(confidential, 0),
      autoApproveNewAccounts: confidential[32] === 1,
      auditorElgamalPubkeyHex: confidential.subarray(33, 65).some((byte) => byte !== 0) ? confidential.subarray(33, 65).toString('hex') : null,
    } : null,
  };
}

export function parseToken2022Account(address: string, account: RpcAccountInfo): Token2022AccountProfile {
  if (account.owner !== TOKEN_2022_PROGRAM || account.executable) throw new Error('Account is not a Token-2022 token account.');
  const value = unpackAccount(new PublicKey(address), web3AccountInfo(account), TOKEN_2022_PROGRAM_ID);
  return {
    address,
    accountSize: accountData(account).length,
    mint: value.mint.toBase58(),
    owner: value.owner.toBase58(),
    amountRaw: value.amount.toString(),
    initialized: value.isInitialized,
    frozen: value.isFrozen,
    native: value.isNative,
    delegate: publicKey(value.delegate),
    delegatedAmountRaw: value.delegatedAmount.toString(),
    closeAuthority: publicKey(value.closeAuthority),
    extensions: getExtensionTypes(value.tlvData).map(extensionName),
  };
}

export function accountData(account: RpcAccountInfo) {
  if (account.data[1] !== 'base64') throw new Error('Account data is not base64 encoded.');
  return Buffer.from(account.data[0], 'base64');
}

export function asWeb3AccountInfo(account: RpcAccountInfo) {
  return web3AccountInfo(account);
}

export function isSupportedXStockMintProfile(profile: Token2022MintProfile) {
  return profile.initialized
    && profile.decimals === 8
    && profile.defaultAccountState === 'INITIALIZED'
    && profile.pausable?.paused === false
    && profile.transferHook?.programId === null
    && profile.tokenAccountSize === 179
    && profile.extensions.length === XSTOCK_MINT_EXTENSIONS.length
    && XSTOCK_MINT_EXTENSIONS.every((extension) => profile.extensions.includes(extension));
}

export function currentScaledUiMultiplier(profile: Token2022MintProfile, unixTimestamp = Math.floor(Date.now() / 1000)) {
  const scaled = profile.scaledUiAmount;
  if (!scaled) return 1;
  return unixTimestamp >= Number(scaled.newMultiplierEffectiveTimestamp) ? scaled.newMultiplier : scaled.multiplier;
}

export function tokenRawToUiAmount(raw: bigint, decimals: number, multiplier = 1) {
  return amountToUiAmountForScaledUiAmountMintWithoutSimulation(raw, decimals, multiplier);
}

export function tokenUiAmountToRaw(uiAmount: string, decimals: number, multiplier = 1) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(uiAmount) || !Number.isFinite(multiplier) || multiplier <= 0) throw new Error('Invalid token UI amount.');
  const raw = uiAmountToAmountForScaledUiAmountMintWithoutSimulation(uiAmount, decimals, multiplier);
  if (raw <= 0n) throw new Error('Token UI amount is below the smallest transferable unit.');
  return raw;
}

export function effectiveRawTokenUsdPriceMicros(uiPriceMicros: bigint, multiplier = 1) {
  if (uiPriceMicros <= 0n || !Number.isFinite(multiplier) || multiplier <= 0) throw new Error('Invalid scaled token price.');
  const scale = 1_000_000_000n;
  const multiplierNanos = BigInt(Math.floor(multiplier * Number(scale)));
  const price = uiPriceMicros * multiplierNanos / scale;
  if (price <= 0n) throw new Error('Scaled token price is too small.');
  return price;
}
