import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { ConnectorClient, createConnectorId, createTransactionSigner } from '@solana/connector/headless';
import { SOLANA_MAINNET_CHAIN } from '@solana/wallet-standard-chains';
import { SolanaSignTransaction } from '@solana/wallet-standard-features';
import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import { StandardConnect, StandardDisconnect, StandardEvents } from '@wallet-standard/features';
import { ComputeBudgetProgram, Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { CONNECTION_TIMEOUT_MS, createWalletBrowserLinks, createWalletConnectorConfig, isWalletConnectConnector, isWalletConnectPairingUri, safeWalletIcon, WALLETCONNECT_TIMEOUT_MS } from '../src/wallet/connectorConfig.js';
import { connectorForWallet, directoryWalletState, filterWalletDirectory, officialWalletUrl, orderWalletDirectory, SOLANA_WALLET_DIRECTORY } from '../src/wallet/walletDirectory.js';
import { assertExactSignedTransaction, inspectWalletMutation, WalletMessageMismatchError } from '../src/wallet/signing.js';
import { signWalletStandardTransaction, WalletSigningError } from '../src/wallet/walletStandardSigning.js';
import { transitionWalletDialog } from '../src/wallet/walletDialogState.js';
import { filterWalletConnectors, readRecentConnector, RECENT_WALLET_KEY, rememberConnectedConnector, rememberSuccessfulConnector } from '../src/wallet/walletPreferences.js';

const browserEvents = new EventTarget();
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    addEventListener: browserEvents.addEventListener.bind(browserEvents),
    removeEventListener: browserEvents.removeEventListener.bind(browserEvents),
    dispatchEvent: browserEvents.dispatchEvent.bind(browserEvents),
    navigator: {},
  },
});
Object.assign((globalThis as unknown as { window: { navigator: { wallets?: ReturnType<typeof getWallets> } } }).window.navigator, { wallets: getWallets() });

type Change = (properties: { accounts?: readonly WalletAccount[] }) => void;

function fakeWallet(name: string, initialAccount = Keypair.generate(), options: { stalled?: boolean; failure?: Error; signingFailure?: Error; mutateSignedMessage?: boolean; crossRealmSignedBytes?: boolean } = {}) {
  let accounts: readonly WalletAccount[] = [];
  let change: Change | undefined;
  let disconnects = 0;
  let signatures = 0;
  const signInputs: unknown[] = [];
  let release: (() => void) | undefined;
  const connectInputs: unknown[] = [];
  const account: WalletAccount = {
    address: initialAccount.publicKey.toBase58(),
    publicKey: initialAccount.publicKey.toBytes(),
    chains: [SOLANA_MAINNET_CHAIN],
    features: [SolanaSignTransaction],
  };
  const value = {
    version: '1.0.0', name, icon: 'data:image/svg+xml,<svg/>', chains: [SOLANA_MAINNET_CHAIN],
    get accounts() { return accounts; },
    features: {
      [StandardConnect]: { version: '1.0.0', connect: async (input?: unknown) => {
        connectInputs.push(input);
        if (options.failure) throw options.failure;
        if (options.stalled) await new Promise<void>((resolve) => { release = resolve; });
        accounts = [account];
        return { accounts };
      } },
      [StandardDisconnect]: { version: '1.0.0', disconnect: async () => { disconnects += 1; accounts = []; } },
      [StandardEvents]: { version: '1.0.0', on: (_event: string, listener: Change) => { change = listener; return () => { change = undefined; }; } },
      [SolanaSignTransaction]: { version: '1.0.0', supportedTransactionVersions: [0], signTransaction: async (...inputs: Array<{ transaction?: Uint8Array }>) => {
        signatures += 1;
        signInputs.push(...inputs);
        const input = inputs[0]!;
        if (options.signingFailure) throw options.signingFailure;
        if (!input.transaction) throw new Error('Use the Wallet Standard singular input.');
        const transaction = VersionedTransaction.deserialize(input.transaction);
        if (options.mutateSignedMessage) transaction.message.recentBlockhash = Keypair.generate().publicKey.toBase58();
        transaction.sign([initialAccount]);
        const serialized = transaction.serialize();
        const signedTransaction = options.crossRealmSignedBytes
          ? runInNewContext('Uint8Array.from(bytes)', { bytes: [...serialized] }) as Uint8Array
          : serialized;
        return [{ signedTransaction }];
      } },
    },
  } as unknown as Wallet;
  return {
    value, account, connectInputs, signInputs, disconnects: () => disconnects, signatures: () => signatures, release: () => release?.(),
    changeAccount(next: Keypair) {
      accounts = [{ ...account, address: next.publicKey.toBase58(), publicKey: next.publicKey.toBytes() }];
      change?.({ accounts });
    },
  };
}

function initializeClient() {
  const client = new ConnectorClient({ autoConnect: false });
  (client as unknown as { initialize: () => void }).initialize();
  return client;
}

function preparedVersionedTransaction(payer: Keypair) {
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })],
  }).compileToV0Message();
  return new VersionedTransaction(message).serialize();
}

function diagnosticTransaction(payer: Keypair, pilot: Keypair, blockhash: string, instructions = [SystemProgram.transfer({ fromPubkey: pilot.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })]) {
  return new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message());
}

test('identical returned v0 message produces no mutation telemetry', async () => {
  const payer = Keypair.generate(); const pilot = Keypair.generate(); const blockhash = Keypair.generate().publicKey.toBase58();
  const prepared = diagnosticTransaction(payer, pilot, blockhash); const returned = VersionedTransaction.deserialize(prepared.serialize()); returned.sign([pilot]);
  const diagnostics = await inspectWalletMutation(prepared.serialize(), returned.serialize());
  assert.deepEqual(diagnostics.differences, []);
  assert.equal(await assertExactSignedTransaction(prepared.serialize(), returned.serialize()) instanceof Uint8Array, true);
  assert.deepEqual(diagnostics.returned.signatureSlotsPopulated, [false, true]);
});

test('added ComputeUnitPrice is decoded and captured without payload bytes', async () => {
  const payer = Keypair.generate(); const pilot = Keypair.generate(); const blockhash = Keypair.generate().publicKey.toBase58(); const recipient = Keypair.generate();
  const transfer = SystemProgram.transfer({ fromPubkey: pilot.publicKey, toPubkey: recipient.publicKey, lamports: 1 });
  const prepared = diagnosticTransaction(payer, pilot, blockhash, [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), transfer]);
  const returned = diagnosticTransaction(payer, pilot, blockhash, [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 40_000n }), transfer]); returned.sign([pilot]);
  const diagnostics = await inspectWalletMutation(prepared.serialize(), returned.serialize());
  assert.deepEqual(diagnostics.prepared.instructions.map((item) => item.type), ['SetComputeUnitLimit', 'Unknown']);
  assert.deepEqual(diagnostics.returned.instructions.map((item) => item.type), ['SetComputeUnitLimit', 'SetComputeUnitPrice', 'Unknown']);
  assert.equal(diagnostics.returned.instructions[1]?.microLamports, '40000');
  assert.ok(diagnostics.differences.some((item) => item.kind === 'instruction_added' && item.returnedIndex === 1));
  const stored = JSON.stringify(diagnostics); assert.doesNotMatch(stored, /serializedTransaction|signedTransaction|rawMessage|signatureBytes/);
  assert.ok(!stored.includes(Buffer.from(returned.serialize()).toString('base64')));
});

test('changed ComputeUnitLimit and blockhash are explicit mutation differences', async () => {
  const payer = Keypair.generate(); const pilot = Keypair.generate(); const blockhash = Keypair.generate().publicKey.toBase58(); const recipient = Keypair.generate();
  const transfer = SystemProgram.transfer({ fromPubkey: pilot.publicKey, toPubkey: recipient.publicKey, lamports: 1 });
  const prepared = diagnosticTransaction(payer, pilot, blockhash, [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), transfer]);
  const returned = diagnosticTransaction(payer, pilot, Keypair.generate().publicKey.toBase58(), [ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }), transfer]);
  const diagnostics = await inspectWalletMutation(prepared.serialize(), returned.serialize());
  assert.equal(diagnostics.prepared.instructions[0]?.units, 200_000); assert.equal(diagnostics.returned.instructions[0]?.units, 250_000);
  assert.ok(diagnostics.differences.some((item) => item.kind === 'instruction_data_changed'));
  assert.ok(diagnostics.differences.some((item) => item.kind === 'blockhash_changed'));
});

test('static key, signer order, instruction order, and LUT mutations are captured', async () => {
  const payer = Keypair.generate(); const otherPayer = Keypair.generate(); const pilot = Keypair.generate(); const blockhash = Keypair.generate().publicKey.toBase58(); const recipient = Keypair.generate();
  const limit = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }); const transfer = SystemProgram.transfer({ fromPubkey: pilot.publicKey, toPubkey: recipient.publicKey, lamports: 1 });
  const prepared = diagnosticTransaction(payer, pilot, blockhash, [limit, transfer]);
  const changedKeys = diagnosticTransaction(otherPayer, pilot, blockhash, [limit, transfer]);
  let diagnostics = await inspectWalletMutation(prepared.serialize(), changedKeys.serialize());
  assert.ok(diagnostics.differences.some((item) => item.kind === 'static_key_added' && item.publicKeys?.includes(otherPayer.publicKey.toBase58())));
  assert.ok(diagnostics.differences.some((item) => item.kind === 'signer_layout_changed'));
  const reordered = diagnosticTransaction(payer, pilot, blockhash, [transfer, limit]); diagnostics = await inspectWalletMutation(prepared.serialize(), reordered.serialize());
  assert.ok(diagnostics.differences.some((item) => item.kind === 'instruction_reordered'));
  const lookup = VersionedTransaction.deserialize(prepared.serialize()); lookup.message.addressTableLookups.push({ accountKey: Keypair.generate().publicKey, writableIndexes: [], readonlyIndexes: [] });
  diagnostics = await inspectWalletMutation(prepared.serialize(), lookup.serialize()); assert.ok(diagnostics.differences.some((item) => item.kind === 'lookup_tables_changed'));
});

test('mismatch remains fail-closed and exposes only bounded signature population booleans', async () => {
  const payer = Keypair.generate(); const pilot = Keypair.generate(); const prepared = diagnosticTransaction(payer, pilot, Keypair.generate().publicKey.toBase58());
  const returned = VersionedTransaction.deserialize(prepared.serialize()); returned.message.recentBlockhash = Keypair.generate().publicKey.toBase58(); returned.sign([pilot]);
  await assert.rejects(() => assertExactSignedTransaction(prepared.serialize(), returned.serialize()), (error: unknown) => {
    assert.ok(error instanceof WalletMessageMismatchError); assert.deepEqual(error.mutationDiagnostics.returned.signatureSlotsPopulated, [false, true]);
    const serialized = JSON.stringify(error.mutationDiagnostics); assert.doesNotMatch(serialized, /"signatures"|"signedTransaction"|"serializedTransaction"|"rawMessage"/); return true;
  });
});

test('ConnectorKit discovers and connects Phantom, Solflare, Backpack, and future Wallet Standard wallets', async () => {
  const fixtures = ['Phantom', 'Solflare', 'Backpack', 'Future Wallet'].map((name) => fakeWallet(name));
  const unregister = getWallets().register(...fixtures.map((item) => item.value));
  const client = initializeClient();
  try {
    assert.deepEqual(client.getSnapshot().connectors.map((item) => item.name), fixtures.map((item) => item.value.name));
    for (const fixture of fixtures) {
      await client.connectWallet(createConnectorId(fixture.value.name));
      const status = client.getSnapshot().wallet;
      assert.equal(status.status, 'connected');
      if (status.status === 'connected') assert.equal(status.session.selectedAccount.address, fixture.account.address);
      assert.deepEqual(fixture.connectInputs.at(-1), { silent: false });
      assert.equal(fixture.signatures(), 0);
      await client.disconnectWallet();
    }
  } finally {
    client.destroy(); unregister();
  }
});

test('ConnectorKit handles disconnect, silent reconnect, account change, rejection, and cancellation', async () => {
  const phantom = fakeWallet('Phantom');
  const rejected = fakeWallet('Rejected Wallet', Keypair.generate(), { failure: new Error('User rejected the request') });
  const stalled = fakeWallet('Stalled Wallet', Keypair.generate(), { stalled: true });
  const unregister = getWallets().register(phantom.value, rejected.value, stalled.value);
  const client = initializeClient();
  try {
    await client.connectWallet(createConnectorId('Phantom'), { silent: true, allowInteractiveFallback: false });
    assert.deepEqual(phantom.connectInputs.at(-1), { silent: true });
    const next = Keypair.generate();
    phantom.changeAccount(next);
    const changed = client.getSnapshot().wallet;
    assert.equal(changed.status, 'connected');
    if (changed.status === 'connected') assert.equal(changed.session.selectedAccount.address, next.publicKey.toBase58());
    await client.disconnectWallet();
    assert.equal(phantom.disconnects(), 1);

    await assert.rejects(client.connectWallet(createConnectorId('Rejected Wallet')), /rejected/);
    const pending = client.connectWallet(createConnectorId('Stalled Wallet'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await client.disconnectWallet();
    stalled.release();
    await assert.rejects(pending, /cancelled/);
    assert.equal(client.getSnapshot().wallet.status, 'disconnected');
  } finally {
    client.destroy(); unregister();
  }
});

test('connection deadlines are bounded for extensions and QR pairing', () => {
  assert.equal(CONNECTION_TIMEOUT_MS, 20_000);
  assert.equal(WALLETCONNECT_TIMEOUT_MS, 120_000);
});

test('only a WalletConnect wc pairing URI may reach the QR renderer', () => {
  assert.equal(isWalletConnectPairingUri('wc:topic@2?relay-protocol=irn&symKey=test'), true);
  assert.equal(isWalletConnectPairingUri('https://example.com/not-a-pairing'), false);
  assert.equal(isWalletConnectPairingUri(null), false);
});

test('WalletConnect transport variants remain identifiable outside the initial chooser', () => {
  assert.equal(isWalletConnectConnector({ id: 'walletconnect' as ReturnType<typeof createConnectorId>, name: 'WalletConnect' }), true);
  assert.equal(isWalletConnectConnector({ id: createConnectorId('WalletConnect'), name: 'WalletConnect' }), true);
  assert.equal(isWalletConnectConnector({ id: 'connector:wc' as ReturnType<typeof createConnectorId>, name: 'WalletConnect' }), true);
  assert.equal(isWalletConnectConnector({ id: createConnectorId('Phantom'), name: 'Phantom' }), false);
});

test('wallet dialog directory is a stable explicit state with Back and Close transitions', () => {
  let view = transitionWalletDialog('closed', 'open');
  assert.equal(view, 'chooser');
  view = transitionWalletDialog(view, 'show-directory');
  assert.equal(view, 'directory');
  assert.equal(transitionWalletDialog(view, 'show-directory'), 'directory');
  view = transitionWalletDialog(view, 'show-walletconnect');
  assert.equal(view, 'walletconnect');
  view = transitionWalletDialog(view, 'back');
  assert.equal(view, 'directory');
  assert.equal(transitionWalletDialog(view, 'back'), 'chooser');
  assert.equal(transitionWalletDialog(view, 'close'), 'closed');
});

test('wallet metadata remains separate from runtime connectors and exposes only verified HTTPS handoffs', () => {
  const expected = ['Phantom', 'Solflare', 'Backpack', 'Glow', 'Nightly', 'Exodus', 'Trust Wallet', 'Coinbase Wallet', 'Brave Wallet', 'Ledger', 'Jupiter Wallet', 'MetaMask', 'OKX Wallet', 'SafePal', 'TokenPocket', 'Bitget Wallet', 'MathWallet', 'Coin98', 'WalletConnect'];
  assert.deepEqual(expected.filter((name) => !SOLANA_WALLET_DIRECTORY.some((entry) => entry.name === name)), []);
  assert.equal(SOLANA_WALLET_DIRECTORY.some((entry) => /magic eden/i.test(entry.name)), false);
  assert.equal(SOLANA_WALLET_DIRECTORY.some((entry) => /base.*coinbase/i.test(entry.name)), false);
  assert.deepEqual(filterWalletDirectory(SOLANA_WALLET_DIRECTORY, 'coinbase').map((entry) => entry.id), ['coinbase']);
  assert.deepEqual(filterWalletDirectory(SOLANA_WALLET_DIRECTORY, 'not-a-wallet'), []);
  for (const entry of SOLANA_WALLET_DIRECTORY) {
    assert.equal(entry.icon, undefined);
    const url = officialWalletUrl(entry);
    if (entry.id === 'walletconnect') assert.equal(url, null);
    else assert.match(url ?? '', /^https:\/\//);
  }
});

test('directory-only wallets never pretend to be installed while ready connectors remain actionable', () => {
  const backpack = SOLANA_WALLET_DIRECTORY.find((entry) => entry.id === 'backpack')!;
  const walletConnect = SOLANA_WALLET_DIRECTORY.find((entry) => entry.id === 'walletconnect')!;
  const connector = { id: createConnectorId('Backpack'), name: 'Backpack', icon: '', ready: true } as Parameters<typeof connectorForWallet>[1][number];
  const walletConnectConnector = { id: 'walletconnect', name: 'WalletConnect', icon: '', ready: true } as Parameters<typeof connectorForWallet>[1][number];
  assert.equal(directoryWalletState(backpack, null, null), 'INSTALL / OPEN');
  assert.equal(connectorForWallet(backpack, [connector]), connector);
  assert.equal(directoryWalletState(backpack, connector, null), 'INSTALLED');
  assert.equal(directoryWalletState(backpack, connector, connector.id), 'RECENT');
  assert.equal(directoryWalletState(walletConnect, null, null), 'UNAVAILABLE');
  assert.equal(directoryWalletState(walletConnect, walletConnectConnector, null), 'QR / MOBILE');
  assert.equal(directoryWalletState(walletConnect, walletConnectConnector, walletConnectConnector.id), 'QR / MOBILE');
});

test('directory order is deliberate, promotes genuinely detected wallets, and keeps WalletConnect last', () => {
  const expected = ['Backpack', 'Jupiter Wallet', 'Glow', 'Nightly', 'Exodus', 'Trust Wallet', 'Coinbase Wallet', 'Brave Wallet', 'MetaMask', 'OKX Wallet', 'Ledger', 'Bitget Wallet', 'SafePal', 'TokenPocket', 'MathWallet', 'Coin98'];
  const staticOrder = orderWalletDirectory(SOLANA_WALLET_DIRECTORY, []).map((entry) => entry.name);
  assert.deepEqual(staticOrder.slice(0, expected.length), expected);
  assert.equal(staticOrder.at(-1), 'WalletConnect');
  const solflare = { id: createConnectorId('Solflare'), name: 'Solflare', icon: '', ready: true } as Parameters<typeof connectorForWallet>[1][number];
  const detectedOrder = orderWalletDirectory(SOLANA_WALLET_DIRECTORY, [solflare]);
  assert.equal(detectedOrder[0]?.name, 'Solflare');
  assert.equal(detectedOrder.at(-1)?.name, 'WalletConnect');
});

test('a prior successful connector remains Recent but never auto-attaches on a fresh GASLESS load', async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  const phantom = fakeWallet('Phantom');
  const connectorId = createConnectorId('Phantom');
  rememberSuccessfulConnector(storage, connectorId);
  const unregister = getWallets().register(phantom.value);
  const client = initializeClient();
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(client.getSnapshot().wallet.status, 'disconnected');
    assert.equal(phantom.connectInputs.length, 0);
    assert.equal(readRecentConnector(storage), connectorId);

    await client.connectWallet(readRecentConnector(storage)!);
    assert.equal(client.getSnapshot().wallet.status, 'connected');
    assert.deepEqual(phantom.connectInputs, [{ silent: false }]);
    assert.equal(phantom.signatures(), 0);
    await client.disconnectWallet();
    assert.equal(client.getSnapshot().wallet.status, 'disconnected');
  } finally {
    client.destroy(); unregister();
  }
});

test('ConnectorKit 0.2.6 keeps the first duplicate Phantom registration', async () => {
  const stale = fakeWallet('Phantom', Keypair.generate(), { failure: new Error('stale Phantom registration') });
  const working = fakeWallet('Phantom');
  const unregister = getWallets().register(stale.value, working.value);
  const client = initializeClient();
  try {
    assert.equal(client.getSnapshot().connectors.filter((item) => item.name === 'Phantom').length, 1);
    await assert.rejects(client.connectWallet(createConnectorId('Phantom')), /stale Phantom registration/);
    assert.equal(stale.connectInputs.length, 1);
    assert.equal(working.connectInputs.length, 0);
  } finally {
    client.destroy(); unregister();
  }
});

test('ConnectorKit exposes no incompatible wallets and renders only safe connector icons', () => {
  const incompatible = { version: '1.0.0', name: 'Not Solana', icon: 'https://tracker.invalid/icon.png', chains: ['ethereum:1'], accounts: [], features: {} } as unknown as Wallet;
  const unregister = getWallets().register(incompatible);
  const client = initializeClient();
  try {
    assert.equal(client.getSnapshot().connectors.some((item) => item.name === 'Not Solana'), false);
    assert.equal(safeWalletIcon(incompatible.icon), null);
    assert.match(safeWalletIcon('data:image/png;base64,AA') ?? '', /^data:image/);
  } finally {
    client.destroy(); unregister();
  }
});

test('mobile configuration registers only the active chain on the current HTTPS origin', () => {
  const mainnet = createWalletConnectorConfig('https://gasless.exchange/path', 'mainnet-beta');
  assert.equal(mainnet.config.autoConnect, false);
  assert.deepEqual(mainnet.mobile.chains, ['solana:mainnet']);
  assert.equal(mainnet.mobile.appIdentity.uri, 'https://gasless.exchange');
  assert.equal(mainnet.mobile.appIdentity.icon, '/favicon.svg');
  const devnet = createWalletConnectorConfig('http://gasless.localhost', 'devnet');
  assert.deepEqual(devnet.mobile.chains, ['solana:devnet']);
});

test('official wallet-browser links are click-only mobile HTTPS fallbacks', () => {
  assert.deepEqual(createWalletBrowserLinks('http://localhost/', true), []);
  assert.deepEqual(createWalletBrowserLinks('https://gasless.exchange/swap?from=sol', false), []);
  const links = createWalletBrowserLinks('https://gasless.exchange/swap?from=sol', true);
  assert.equal(links.length, 2);
  assert.equal(links[0]?.href, 'https://phantom.app/ul/browse/https%3A%2F%2Fgasless.exchange%2Fswap%3Ffrom%3Dsol?ref=https%3A%2F%2Fgasless.exchange');
  assert.equal(links[1]?.href, 'https://solflare.com/ul/v1/browse/https%3A%2F%2Fgasless.exchange%2Fswap%3Ffrom%3Dsol?ref=https%3A%2F%2Fgasless.exchange');
});

test('WalletConnect is configured only when a browser-safe project ID is present', () => {
  const missing = createWalletConnectorConfig('https://gasless.exchange', 'mainnet-beta');
  assert.equal(missing.config.walletConnect, undefined);
  const configured = createWalletConnectorConfig('https://gasless.exchange', 'mainnet-beta', false, 'project-id');
  assert.equal(configured.config.walletConnect?.enabled, true);
  assert.equal(configured.config.walletConnect?.projectId, 'project-id');
});

test('Recent stores only a successful connector ID and search uses real ready connectors', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  assert.equal(readRecentConnector(storage), null);
  rememberSuccessfulConnector(storage, createConnectorId('Phantom'));
  assert.equal(values.get(RECENT_WALLET_KEY), 'wallet-standard:phantom');
  assert.equal(readRecentConnector(storage), 'wallet-standard:phantom');
  const connectors = [
    { id: createConnectorId('Phantom'), name: 'Phantom', icon: '', ready: true, chains: [], features: [] },
    { id: createConnectorId('Unavailable'), name: 'Unavailable', icon: '', ready: false, chains: [], features: [] },
  ];
  assert.deepEqual(filterWalletConnectors(connectors, 'phan').map((item) => item.name), ['Phantom']);
  assert.deepEqual(filterWalletConnectors(connectors, '').map((item) => item.name), ['Phantom']);
});

test('failed or cancelled pairing never becomes Recent while a connected WalletConnect account does', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  const walletConnect = 'walletconnect' as NonNullable<ReturnType<typeof readRecentConnector>>;
  assert.equal(rememberConnectedConnector(storage, 'connecting', walletConnect), false);
  assert.equal(rememberConnectedConnector(storage, 'error', walletConnect), false);
  assert.equal(rememberConnectedConnector(storage, 'disconnected', walletConnect), false);
  assert.equal(readRecentConnector(storage), null);
  assert.equal(rememberConnectedConnector(storage, 'connected', walletConnect), true);
  assert.equal(readRecentConnector(storage), walletConnect);
});

test('transaction signer returns exact versioned bytes without a sign-and-send capability', async () => {
  const payer = Keypair.generate();
  const fixture = fakeWallet('Signing Wallet', payer);
  const transaction = preparedVersionedTransaction(payer);
  const signer = createTransactionSigner({ wallet: fixture.value, account: fixture.account });
  assert.ok(signer);
  assert.equal(signer.getCapabilities().canSend, false);
  const signed = await signer.signTransaction(transaction);
  assert.ok(signed instanceof Uint8Array);
  assert.equal(await assertExactSignedTransaction(transaction, signed), signed);
  assert.equal(fixture.signatures(), 2, 'ConnectorKit first sends a non-standard batch-shaped request before retrying');
});

test('GASLESS invokes Wallet Standard signing once with the canonical singular input', async () => {
  const payer = Keypair.generate();
  const fixture = fakeWallet('Phantom', payer);
  const transaction = preparedVersionedTransaction(payer);
  const signed = await signWalletStandardTransaction({ wallet: fixture.value, account: fixture.account, transaction, chain: SOLANA_MAINNET_CHAIN, connectorName: 'Phantom' });
  assert.equal(fixture.signatures(), 1);
  assert.equal(fixture.signInputs.length, 1);
  assert.deepEqual(Object.keys(fixture.signInputs[0] as object).sort(), ['account', 'chain', 'transaction']);
  assert.equal(await assertExactSignedTransaction(transaction, signed), signed);
});

test('GASLESS accepts valid signed bytes returned from a wallet extension realm', async () => {
  const payer = Keypair.generate();
  const fixture = fakeWallet('Phantom', payer, { crossRealmSignedBytes: true });
  const transaction = preparedVersionedTransaction(payer);
  const signed = await signWalletStandardTransaction({ wallet: fixture.value, account: fixture.account, transaction, chain: SOLANA_MAINNET_CHAIN, connectorName: 'Phantom' });
  assert.equal(fixture.signatures(), 1);
  assert.ok(signed instanceof Uint8Array);
  assert.equal(await assertExactSignedTransaction(transaction, signed), signed);
});

test('GASLESS preserves the wallet cause without retrying a failed signing request', async () => {
  const payer = Keypair.generate();
  const cause = Object.assign(new Error('wallet transport unavailable'), { code: 'E_PROVIDER' });
  const fixture = fakeWallet('Phantom', payer, { signingFailure: cause });
  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    await assert.rejects(
      signWalletStandardTransaction({ wallet: fixture.value, account: fixture.account, transaction: preparedVersionedTransaction(payer), chain: SOLANA_MAINNET_CHAIN, connectorName: 'Phantom' }),
      (error: unknown) => error instanceof WalletSigningError && error.message === 'Failed to sign transaction' && error.cause === cause && error.classification === 'WALLET_PROVIDER_ERROR' && error.providerCode === 'E_PROVIDER' && error.providerName === 'Error' && error.providerMessage === 'wallet transport unavailable',
    );
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(fixture.signatures(), 1);
});

test('wallet signing telemetry never sends the raw wallet exception to Sentry', () => {
  const source = readFileSync('src/wallet/walletStandardSigning.ts', 'utf8');
  assert.doesNotMatch(source, /Sentry\.captureException/);
  assert.match(source, /console\.error\('\[GASLESS\] Wallet signing failed', JSON\.stringify\(details\)\)/);
  assert.match(source, /Sentry\.captureMessage\('Wallet signing failed'/);
});

test('GASLESS rejects a wallet-signed transaction whose message changed', async () => {
  const payer = Keypair.generate();
  const fixture = fakeWallet('Phantom', payer, { mutateSignedMessage: true });
  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    await assert.rejects(
      signWalletStandardTransaction({ wallet: fixture.value, account: fixture.account, transaction: preparedVersionedTransaction(payer), chain: SOLANA_MAINNET_CHAIN, connectorName: 'Phantom' }),
      (error: unknown) => error instanceof WalletSigningError && error.message === 'Failed to sign transaction' && error.mutationDiagnostics?.differences.some((item) => item.kind === 'blockhash_changed') === true,
    );
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(fixture.signatures(), 1);
});

test('exact-message guard rejects a wallet-mutated versioned transaction', async () => {
  const payer = Keypair.generate();
  const prepared = preparedVersionedTransaction(payer);
  const changed = VersionedTransaction.deserialize(prepared);
  changed.message.recentBlockhash = Keypair.generate().publicKey.toBase58();
  changed.sign([payer]);
  await assert.rejects(() => assertExactSignedTransaction(prepared, changed.serialize()), /changed the prepared transaction/);
});

test('Swap cleanup remains intact and obsolete wallet diagnostics are removed', () => {
  const swap = readFileSync('src/features/swap/components/SwapConsole.tsx', 'utf8');
  const provider = readFileSync('src/wallet/WalletProvider.tsx', 'utf8');
  assert.doesNotMatch(swap, /<GaslessStatus/);
  assert.doesNotMatch(swap, /SLIPPAGE PROTECTION/);
  assert.match(swap, /<DetailSection>[\s\S]*htmlFor="swap-slippage"/);
  assert.doesNotMatch(provider, /wallet-debug|WalletDebugPanel|getWallets|standard:connect/);
  assert.match(provider, /useWalletConnectors/);
  assert.match(provider, /useConnectWallet/);
  assert.match(provider, /useConnectorWallet/);
  assert.match(provider, /useDisconnectWallet/);
  assert.match(provider, /useWalletConnectUri/);
  assert.doesNotMatch(provider, /useConnector\(/);
  assert.doesNotMatch(provider, /reconnectAttempted|connect\(recentConnector\.id/);
  assert.match(provider, /CONNECTING\.\.\./);
  assert.match(provider, /MORE WALLETS/);
  assert.match(provider, /onClick=\{\(\) => changeDialogView\('show-directory'\)\}/);
  assert.match(provider, /onPointerDown=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(provider, /placeholder="Search wallets\.\.\."/);
  assert.match(provider, /detectedConnectors\.map/);
  assert.match(provider, /item\.id === recentConnectorId && !isWalletConnectConnector\(item\)/);
  assert.match(provider, /item\.id !== recentConnectorId && !isWalletConnectConnector\(item\)/);
  assert.match(provider, /directoryWalletState/);
  assert.match(provider, /onError=\{\(\) => setFailed\(true\)\}/);
  assert.match(provider, /show-walletconnect/);
  assert.doesNotMatch(provider, /<div className="wallet-section"><small>WALLETCONNECT<\/small>/);
  assert.doesNotMatch(provider, /connector=\{walletConnectConnector\}[\s\S]{0,160}label="INSTALLED"/);
  assert.match(provider, /walletConnectPairingUri \? <div className="wallet-qr"><QRCodeSVG value=\{walletConnectPairingUri\}/);
  assert.match(provider, /SCAN WITH A COMPATIBLE WALLET/);
  assert.match(provider, /Use a WalletConnect-compatible mobile wallet to scan this QR\./);
  assert.match(provider, /OPEN IN WALLET APP/);
  assert.match(provider, /OPEN IN WALLET/);
  assert.match(provider, /RETRY WALLETCONNECT/);
  assert.match(provider, /const isWalletConnect = isWalletConnectConnector\(selectedConnector\)/);
  assert.match(provider, /const timeout = isWalletConnect \? WALLETCONNECT_TIMEOUT_MS : CONNECTION_TIMEOUT_MS/);
  assert.match(provider, /clearWalletConnectUri\(\);[\s\S]*await disconnectWallet\(\)/);
  assert.match(provider, /rememberConnectedConnector\(localStorage, walletState\.status, walletState\.connectorId\)/);
  assert.doesNotMatch(provider, /signAndSendTransaction|sign-and-send/);
});
