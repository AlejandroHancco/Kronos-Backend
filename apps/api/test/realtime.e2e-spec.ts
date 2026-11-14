import { Server as HttpServer } from 'http';
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
  }
}

const redisUrl = process.env.REDIS_URL;
const maybe = redisUrl ? describe : describe.skip;

maybe('realtime: publisher -> redis -> socket.io (two servers)', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let client: ClientSocket;
  let publisher: RealtimePublisher;
  const servers: HttpServer[] = [];

  async function boot(withPublisher: boolean) {
    const mod = await Test.createTestingModule({
      imports: withPublisher ? [RealtimeModule] : [],
      providers: [TestKronosGateway],
    }).compile();
    const app = mod.createNestApplication();
    app.useWebSocketAdapter(new RedisIoAdapter(app));
    await app.listen(0);
    return app;
  }

  beforeAll(async () => {
    appA = await boot(true);
    appB = await boot(false);
    publisher = appA.get(RealtimePublisher);
    const port = (appB.getHttpServer().address() as AddressInfo).port;
    client = ioClient(`http://localhost:${port}/kronos`, { transports: ['websocket'] });
    await new Promise<void>((res) => client.on('connect', () => res()));
    client.emit('join', 'u1');
    await new Promise((r) => setTimeout(r, 300));
  });

  afterAll(async () => {
    client?.close();
    await appA?.close();
    await appB?.close();
    servers.forEach((s) => s.close());
  });

  it('delivers job:status published from server A to a client on server B', async () => {
    const received = new Promise((resolve, reject) => {
      client.on('job:status', resolve);
      setTimeout(() => reject(new Error('timeout')), 2000);
    });
    publisher.jobStatus('u1', { jobId: 'j1', status: 'queued' });
    await expect(received).resolves.toEqual({ jobId: 'j1', status: 'queued' });
  });
});
