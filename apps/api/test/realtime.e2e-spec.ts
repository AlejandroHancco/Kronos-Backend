import { AddressInfo } from 'net';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { WebSocketGateway, SubscribeMessage, ConnectedSocket, MessageBody } from '@nestjs/websockets';
import { RealtimePublisher, RealtimeModule } from '@app/realtime';
import { RedisIoAdapter } from '../src/realtime/redis-io.adapter';

@WebSocketGateway({ namespace: 'kronos', cors: true })
class TestKronosGateway {
  @SubscribeMessage('join')
  join(@ConnectedSocket() socket: any, @MessageBody() userId: string) {
    socket.join(`user:${userId}`);
    return { joined: `user:${userId}` }; // ack: el cliente sabe que ya está en la sala
  }
}

const redisUrl = process.env.REDIS_URL;
const maybe = redisUrl ? describe : describe.skip;

maybe('realtime: publisher -> redis -> socket.io (two servers)', () => {
  // Todo lo que se crea se registra aquí y se cierra en afterAll, aunque beforeAll falle a medias.
  const apps: INestApplication[] = [];
  let client: ClientSocket | undefined;
  let publisher: RealtimePublisher;
  let appB: INestApplication;

  async function boot(withPublisher: boolean) {
    const mod = await Test.createTestingModule({
      imports: withPublisher ? [RealtimeModule] : [],
      providers: [TestKronosGateway],
    }).compile();
    const app = mod.createNestApplication();
    apps.push(app);
    app.useWebSocketAdapter(new RedisIoAdapter(app));
    await app.listen(0);
    return app;
  }

  beforeAll(async () => {
    const appA = await boot(true);
    appB = await boot(false);
    publisher = appA.get(RealtimePublisher);
    const port = (appB.getHttpServer().address() as AddressInfo).port;
    client = ioClient(`http://localhost:${port}/kronos`, { transports: ['websocket'] });
    await new Promise<void>((res) => client!.on('connect', () => res()));
    // Espera el ack del join en lugar de dormir un tiempo fijo.
    await expect(client.timeout(2000).emitWithAck('join', 'u1')).resolves.toEqual({ joined: 'user:u1' });
  });

  afterAll(async () => {
    client?.close();
    // app.close() cierra también el servidor HTTP y el de Socket.io (y sus clientes Redis).
    await Promise.allSettled(apps.map((app) => app.close()));
  });

  it('delivers job:status published from server A to a client on server B', async () => {
    // La suscripción Redis del adapter de B puede tardar en estar lista:
    // se reintenta el publish hasta recibir el evento (o agotar el plazo).
    const received = new Promise((resolve) => client!.once('job:status', resolve));
    let retry: NodeJS.Timeout | undefined;
    let deadline: NodeJS.Timeout | undefined;
    const publish = () => publisher.jobStatus('u1', { jobId: 'j1', status: 'queued' });
    try {
      publish();
      retry = setInterval(publish, 100);
      const timeout = new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error('timeout waiting for job:status')), 3000);
      });
      await expect(Promise.race([received, timeout])).resolves.toEqual({ jobId: 'j1', status: 'queued' });
    } finally {
      clearInterval(retry);
      clearTimeout(deadline);
    }
  });
});
