import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../socket/socket.manager.js', () => ({
  getIO: vi.fn(() => ({
    to: vi.fn().mockReturnThis(),
    emit: vi.fn(),
  })),
}));

import { getIO } from '../../socket/socket.manager.js';

describe('project socket emissions', () => {
  let fakeIO: any;

  beforeEach(() => {
    fakeIO = { to: vi.fn().mockReturnThis(), emit: vi.fn() };
    vi.mocked(getIO).mockReturnValue(fakeIO);
  });

  it('emits project:updated to room after successful update', async () => {
    const { emitProjectUpdated } = await import('./projects.controller.js');
    emitProjectUpdated('proj123', { title: 'new title' });

    expect(fakeIO.to).toHaveBeenCalledWith('project:proj123');
    expect(fakeIO.emit).toHaveBeenCalledWith('project:updated', { projectId: 'proj123', title: 'new title' });
  });
});
