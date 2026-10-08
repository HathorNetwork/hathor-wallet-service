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

  it('attributes a ready wallet whose shielded upgrade failed', () => {
    // The wallet-service rebuilds `wallet_balance` and `wallet_tx_history` in
    // the transaction that records the failure, so the totals hold every delta
    // skipped while `ct_status` was `creating`, and increments resume on top.
    // That rebuild has to deploy first: on unrebuilt totals the first large
    // debit underflows the BIGINT UNSIGNED columns and halts sync.
    expect(isWalletAttributable(wallet({ ctStatus: WalletStatus.ERROR }))).toBe(true);
  });

  it('does not attribute a wallet whose fresh load failed on both sides', () => {
    expect(isWalletAttributable(wallet({ status: WalletStatus.ERROR, ctStatus: WalletStatus.ERROR }))).toBe(false);
  });
});
