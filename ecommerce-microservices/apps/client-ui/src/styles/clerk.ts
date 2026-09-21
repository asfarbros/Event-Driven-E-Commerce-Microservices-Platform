import type { ClerkProviderProps } from '@clerk/clerk-react';
type Appearance = NonNullable<ClerkProviderProps['appearance']>;

/** Read a design token from the stylesheet so Clerk's components use the exact same values (no duplicated hex). */
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Clerk's pre-built components themed to the OrderFlow tokens so they do not look bolted on. */
export function clerkAppearance(): Appearance {
  return {
    variables: {
      colorPrimary: token('--color-accent'),
      colorBackground: token('--color-surface'),
      colorText: token('--color-ink'),
      colorTextSecondary: token('--color-muted'),
      colorInputBackground: token('--color-surface'),
      colorInputText: token('--color-ink'),
      colorNeutral: token('--color-ink'),
      colorDanger: token('--color-danger'),
      colorSuccess: token('--color-success'),
      colorWarning: token('--color-warning'),
      borderRadius: token('--radius-md'),
      fontFamily: token('--font-sans'),
      fontFamilyButtons: token('--font-sans'),
      fontSize: '0.9375rem',
    },
    elements: {
      rootBox: 'w-full',
      cardBox: 'shadow-none border border-border rounded-lg w-full max-w-md',
      card: 'shadow-none bg-surface',
      headerTitle: 'font-display font-medium text-2xl tracking-tight',
      formButtonPrimary: 'h-11 rounded-md text-sm font-semibold shadow-none hover:bg-accent-hover',
      formFieldInput: 'h-11 rounded-md border-border-strong shadow-none',
      socialButtonsBlockButton: 'h-11 rounded-md border-border-strong shadow-none',
      footer: 'bg-surface-2',
      userButtonPopoverCard: 'shadow-popover border border-border rounded-lg',
      userButtonAvatarBox: 'size-8',
    },
  };
}
