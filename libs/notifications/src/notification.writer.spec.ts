import { NotificationWriter } from './notification.writer';

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
