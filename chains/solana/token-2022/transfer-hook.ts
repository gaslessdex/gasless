import {
  TOKEN_2022_PROGRAM_ID,
  addExtraAccountMetasForExecute,
  createTransferCheckedInstruction,
  getExtraAccountMetaAddress,
} from '@solana/spl-token';
import { PublicKey, type AccountInfo, type Connection, type TransactionInstruction } from '@solana/web3.js';
import type { SolanaRpc } from '../../../server/solana/rpc.js';
import { asWeb3AccountInfo, parseToken2022Mint } from './accounts.js';

type AccountReader = Pick<SolanaRpc, 'getAccountInfo'>;

function resolverConnection(rpc: AccountReader) {
  return {
    getAccountInfo: async (address: PublicKey): Promise<AccountInfo<Buffer> | null> => {
      const account = await rpc.getAccountInfo(address.toBase58());
      return account ? asWeb3AccountInfo(account) : null;
    },
  } as unknown as Connection;
}

export interface Token2022TransferResolution {
  instruction: TransactionInstruction;
  hookProgramId: string | null;
  extraAccountMetaList: string | null;
  resolvedExtraAccounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
}

/**
 * Builds TransferChecked and resolves the standard SPL TransferHook meta list.
 * A configured hook must be explicitly pinned by the caller. A disabled hook
 * extension (program_id=None) adds no accounts and cannot execute a CPI.
 */
export async function createToken2022TransferChecked(input: {
  rpc: AccountReader;
  source: string;
  mint: string;
  destination: string;
  owner: string;
  amount: bigint;
  decimals: number;
  approvedHookProgramId: string | null;
}): Promise<Token2022TransferResolution> {
  const mintAccount = await input.rpc.getAccountInfo(input.mint);
  if (!mintAccount) throw new Error('Token-2022 mint is missing.');
  const profile = parseToken2022Mint(input.mint, mintAccount);
  if (!profile.transferHook) throw new Error('Token-2022 mint is outside the approved TransferHook profile.');
  if (profile.transferHook.programId !== input.approvedHookProgramId) throw new Error('TransferHook program changed from the approved profile.');
  if (profile.decimals !== input.decimals || !profile.initialized || profile.pausable?.paused) throw new Error('Token-2022 mint is not transferable under the approved profile.');

  const source = new PublicKey(input.source);
  const mint = new PublicKey(input.mint);
  const destination = new PublicKey(input.destination);
  const owner = new PublicKey(input.owner);
  const instruction = createTransferCheckedInstruction(source, mint, destination, owner, input.amount, input.decimals, [], TOKEN_2022_PROGRAM_ID);
  if (!profile.transferHook.programId) return { instruction, hookProgramId: null, extraAccountMetaList: null, resolvedExtraAccounts: [] };

  const hookProgram = new PublicKey(profile.transferHook.programId);
  const listAddress = getExtraAccountMetaAddress(mint, hookProgram);
  const list = await input.rpc.getAccountInfo(listAddress.toBase58());
  if (!list || list.owner !== hookProgram.toBase58() || list.executable) throw new Error('TransferHook ExtraAccountMetaList is missing or invalid.');
  await addExtraAccountMetasForExecute(resolverConnection(input.rpc), instruction, hookProgram, source, mint, destination, owner, input.amount, 'confirmed');
  const resolved = instruction.keys.slice(4);
  if (resolved.length < 2 || !resolved.at(-2)?.pubkey.equals(hookProgram) || !resolved.at(-1)?.pubkey.equals(listAddress)) throw new Error('TransferHook accounts were not resolved in the standard order.');
  return {
    instruction,
    hookProgramId: hookProgram.toBase58(),
    extraAccountMetaList: listAddress.toBase58(),
    resolvedExtraAccounts: resolved.map((meta) => ({ pubkey: meta.pubkey.toBase58(), isSigner: meta.isSigner, isWritable: meta.isWritable })),
  };
}
