import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PERMISSIONS } from '@/domain/permissions';
import { ImageUpload, MAX_IMAGE_BYTES } from './ImageUpload';
import { PermissionMatrix, groupsOf } from './PermissionMatrix';

describe('PermissionMatrix', () => {
  it('lists every catalogue code exactly once (a missing or duplicated code is a hole in the role editor)', () => {
    const rows = groupsOf().flatMap((g) => g.codes);
    expect(rows).toHaveLength(Object.keys(PERMISSIONS).length);
    expect(new Set(rows)).toEqual(new Set(Object.keys(PERMISSIONS)));
    render(<PermissionMatrix value={[]} onChange={() => {}} label="สิทธิ์" />);
    const boxes = [...document.querySelectorAll<HTMLInputElement>('input[data-code]')].map((b) => b.dataset.code);
    expect(boxes).toHaveLength(Object.keys(PERMISSIONS).length);
    expect(new Set(boxes).size).toBe(boxes.length);
    expect(new Set(boxes)).toEqual(new Set(Object.keys(PERMISSIONS)));
  });
  it('ticks what the role holds, toggles one code, and a read-only matrix cannot be changed', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<PermissionMatrix value={['party.read']} onChange={onChange} label="สิทธิ์" />);
    const box = (c: string) => document.querySelector<HTMLInputElement>(`input[data-code="${c}"]`)!;
    expect(box('party.read').checked).toBe(true);
    expect(box('party.manage').checked).toBe(false);
    await userEvent.setup().click(box('party.manage'));
    expect(onChange).toHaveBeenCalledWith(['party.read', 'party.manage']);
    rerender(<PermissionMatrix value={['party.read']} readOnly label="สิทธิ์" />);
    expect(box('party.manage')).toBeDisabled();
    expect(screen.queryByText('ทั้งหมด')).toBeNull();
  });
});

describe('ImageUpload', () => {
  const file = (type: string, bytes: number) => new File([new Uint8Array(bytes)], 'x', { type });
  it('rejects a wrong type and an oversize file before reading them; accepts a small png (svg is always refused)', async () => {
    const onChange = vi.fn();
    const u = userEvent.setup({ applyAccept: false });
    render(<ImageUpload label="ตราประทับ" onChange={onChange} />);
    const input = screen.getByLabelText('ตราประทับ');
    await u.upload(input, file('image/svg+xml', 10));
    expect(screen.getByRole('alert')).toHaveTextContent('PNG');
    await u.upload(input, file('image/png', MAX_IMAGE_BYTES + 1));
    expect(screen.getByRole('alert')).toHaveTextContent('1 MB');
    expect(onChange).not.toHaveBeenCalled();
    await u.upload(input, file('image/png', 10));
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.stringMatching(/^data:image\/png;base64,/)));
  });
});
