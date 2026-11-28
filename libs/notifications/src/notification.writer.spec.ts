import { NotificationWriter, deviceOfflineMessage, deviceOnlineMessage } from './notification.writer';

describe('NotificationWriter', () => {
  it('notifyTeamMeasurementFailed logs one event, creates recipients and publishes per member', async () => {
    const createdAt = new Date();
    const prisma: any = {
      activityEvent: {
        create: jest.fn().mockResolvedValue({
          id: 7,
          type: 'MEASUREMENT_FAILED',
          title: 'Error al medir',
          message: 'Ocurrió un error al medir en "P": boom\nMUX',
          createdAt,
        }),
      },
      activityEventRecipient: { createMany: jest.fn().mockResolvedValue({}) },
      teamMember: {
        findMany: jest.fn().mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]),
      },
    };
    const publisher: any = { notification: jest.fn() };
    const writer = new NotificationWriter(prisma, publisher);

    await writer.notifyTeamMeasurementFailed('t1', 'P', ['MUX'], 'boom');

    expect(prisma.teamMember.findMany).toHaveBeenCalledWith({
      where: { teamId: 't1', status: 'APPROVED' },
      select: { userId: true },
    });
    expect(prisma.activityEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.activityEvent.create.mock.calls[0][0].data).toMatchObject({
      teamId: 't1',
      type: 'MEASUREMENT_FAILED',
      message: 'Ocurrió un error al medir en "P": boom\nMUX',
    });
    expect(prisma.activityEventRecipient.createMany).toHaveBeenCalledWith({
      data: [
        { eventId: 7, userId: 'u1' },
        { eventId: 7, userId: 'u2' },
      ],
      skipDuplicates: true,
    });
    expect(publisher.notification).toHaveBeenCalledTimes(2);
    expect(publisher.notification).toHaveBeenCalledWith('u1', {
      id: 7,
      type: 'MEASUREMENT_FAILED',
      title: 'Error al medir',
      message: 'Ocurrió un error al medir en "P": boom\nMUX',
      read: false,
      createdAt,
    });
  });
});

describe('NotificationWriter device alerts', () => {
  function setup() {
    const createdAt = new Date();
    const prisma: any = {
      activityEvent: { create: jest.fn(async ({ data }: any) => ({ id: 9, createdAt, ...data })) },
      activityEventRecipient: { createMany: jest.fn().mockResolvedValue({}) },
    };
    const publisher: any = { notification: jest.fn() };
    return { writer: new NotificationWriter(prisma, publisher), prisma, publisher };
  }

  it('mensajes de desconexión y recuperación (singular y plural)', () => {
    expect(deviceOfflineMessage('Hioki 1', '14:05', 3)).toBe('Hioki 1 se desconectó a las 14:05. 3 mediciones programadas en la próxima hora.');
    expect(deviceOfflineMessage('Hioki 1', '14:05', 1)).toBe('Hioki 1 se desconectó a las 14:05. 1 medición programada en la próxima hora.');
    expect(deviceOnlineMessage('Hioki 1', 12, 2)).toBe('Hioki 1 volvió a estar disponible (desconectado 12 min). Puntos perdidos: 2.');
  });

  it('notifyDeviceOffline: un evento DEVICE_OFFLINE del equipo con un destinatario por usuario', async () => {
    const { writer, prisma, publisher } = setup();
    await writer.notifyDeviceOffline('t1', ['u1', 'u2'], { id: 'd1', name: 'Hioki 1' }, 0, '14:05');
    expect(prisma.activityEvent.create.mock.calls[0][0].data).toEqual({
      teamId: 't1',
      type: 'DEVICE_OFFLINE',
      title: 'Equipo desconectado',
      message: 'Hioki 1 se desconectó a las 14:05. 0 mediciones programadas en la próxima hora.',
      createdAt: undefined,
    });
    expect(prisma.activityEventRecipient.createMany).toHaveBeenCalledWith({
      data: [{ eventId: 9, userId: 'u1' }, { eventId: 9, userId: 'u2' }],
      skipDuplicates: true,
    });
    expect(publisher.notification).toHaveBeenCalledTimes(2);
  });

  it('notifyDeviceOnline: un evento DEVICE_ONLINE con minutos desconectado y puntos perdidos', async () => {
    const { writer, prisma, publisher } = setup();
    await writer.notifyDeviceOnline('t1', ['u1'], { id: 'd1', name: 'Hioki 1' }, 7, 1);
    expect(prisma.activityEvent.create.mock.calls[0][0].data).toMatchObject({
      teamId: 't1',
      type: 'DEVICE_ONLINE',
      title: 'Equipo disponible',
      message: 'Hioki 1 volvió a estar disponible (desconectado 7 min). Puntos perdidos: 1.',
    });
    expect(publisher.notification).toHaveBeenCalledWith('u1', expect.objectContaining({ type: 'DEVICE_ONLINE' }));
  });
});
