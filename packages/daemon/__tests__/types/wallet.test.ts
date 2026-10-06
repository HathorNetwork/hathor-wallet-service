import { isWalletAttributable, Wallet, WalletStatus } from '../../src/types/wallet';

const wallet = (over: Partial<Wallet> = {}): Wallet => ({
  walletId: 'w1',
  xpubkey: 'xpub',
  authXpubkey: 'auth',
  maxGap: 20,
  status: WalletStatus.READY,
  ...over,
});

describe('isWalletAttributable', () => {
  it('attributes a ready wallet with no shielded keys', () => {
    expect(isWalletAttributable(wallet({ ctStatus: 'none' }))).toBe(true);
    expect(isWalletAttributable(wallet({ ctStatus: undefined }))).toBe(true);
  });

  it('attributes a wallet whose both lifecycles are ready', () => {
    expect(isWalletAttributable(wallet({ ctStatus: WalletStatus.READY }))).toBe(true);
  });

  it('does not attribute a wallet still loading either side', () => {
    expect(isWalletAttributable(wallet({ ctStatus: WalletStatus.CREATING }))).toBe(false);
    expect(isWalletAttributable(wallet({ status: WalletStatus.CREATING, ctStatus: 'none' }))).toBe(false);
  });

  it('does not attribute a wallet whose transparent load failed', () => {
    expect(isWalletAttributable(wallet({ status: WalletStatus.ERROR, ctStatus: 'none' }))).toBe(false);
  });

  it('does not attribute a wallet whose shielded load failed', () => {
    // Deliberate, and load-bearing. A failed shielded load does NOT rebuild
    // `wallet_balance` — markWalletLoadError only touches the `wallet` row — so
    // the stored balance is missing every delta skipped while `ct_status` was
    // `creating`. Resuming increments on top of that underflows the BIGINT
    // UNSIGNED columns inside the ingest or void transaction, which halts sync
    // for every wallet. The frozen-balance bug this masks is real, but it has
    // to be fixed by rebuilding on the error path first.
    expect(isWalletAttributable(wallet({ ctStatus: WalletStatus.ERROR }))).toBe(false);
  });
});
