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

  it('attributes a wallet whose shielded registration failed', () => {
    // The shielded load has terminated, so no absolute rebuild is in flight —
    // withholding attribution here would freeze the wallet's transparent
    // balance as well.
    expect(isWalletAttributable(wallet({ ctStatus: WalletStatus.ERROR }))).toBe(true);
  });

  it('does not attribute a wallet still loading either side', () => {
    expect(isWalletAttributable(wallet({ ctStatus: WalletStatus.CREATING }))).toBe(false);
    expect(isWalletAttributable(wallet({ status: WalletStatus.CREATING, ctStatus: 'none' }))).toBe(false);
  });

  it('does not attribute a wallet whose transparent load failed', () => {
    expect(isWalletAttributable(wallet({ status: WalletStatus.ERROR, ctStatus: 'none' }))).toBe(false);
  });
});
