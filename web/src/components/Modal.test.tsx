import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Modal } from './Modal';

function renderModal(onClose = vi.fn()) {
  render(
    <Modal
      title="New customer"
      description="Add someone to bill"
      onClose={onClose}
      footer={<button type="button">Cancel</button>}
    >
      <input aria-label="Name" />
    </Modal>,
  );
  return onClose;
}

describe('Modal', () => {
  it('is a dialog named by its title', () => {
    renderModal();

    const dialog = screen.getByRole('dialog', { name: 'New customer' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('Add someone to bill')).toBeInTheDocument();
  });

  // Without this, focus stays on the button behind the dialog and the next
  // Tab walks the page underneath instead of the form.
  it('moves focus into the panel when it opens', () => {
    renderModal();

    expect(screen.getByRole('dialog', { name: 'New customer' })).toHaveFocus();
  });

  it('closes on Escape', async () => {
    const onClose = renderModal();

    await userEvent.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders its children and footer', () => {
    renderModal();

    expect(screen.getByLabelText('Name')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('wraps Tab from the last focusable element back to the first', async () => {
    renderModal();

    const cancelButton = screen.getByRole('button', { name: 'Cancel' });
    cancelButton.focus();

    await userEvent.tab();

    expect(screen.getByLabelText('Name')).toHaveFocus();
  });

  it('wraps Shift+Tab from the first focusable element to the last', async () => {
    renderModal();

    screen.getByLabelText('Name').focus();

    await userEvent.tab({ shift: true });

    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('wraps Shift+Tab pressed right after opening, before focus has left the panel', async () => {
    renderModal();

    expect(screen.getByRole('dialog', { name: 'New customer' })).toHaveFocus();

    await userEvent.tab({ shift: true });

    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('stops listening for Escape once it is gone', async () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <Modal title="New customer" onClose={onClose}>
        <p>Body</p>
      </Modal>,
    );

    unmount();
    await userEvent.keyboard('{Escape}');

    expect(onClose).not.toHaveBeenCalled();
  });
});
