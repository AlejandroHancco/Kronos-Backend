import { Test } from '@nestjs/testing';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { PrismaService } from '@app/database';
import { DEVICE_MODELS, DEVICE_MODEL_DEFINITIONS, LaasCatalog } from '@app/laas-catalog';
import { LaasMetadataController } from './laas-metadata.controller';
import { DEFAULT_LAAS_BASE_URL, LaasMetadataService } from './laas-metadata.service';
import { LAAS_MODELS, LAAS_OPERATIONS } from './laas-operations';

const ENV_KEYS = ['LAAS_TITLE', 'LAAS_DESCRIPTION', 'LAAS_TERMS_URL', 'LAAS_CONTACT', 'LAAS_LICENSE', 'LAAS_LICENSE_URL', 'LAAS_BASE_URL', 'SUPABASE_URL', 'FRONTEND_URL'];

describe('GET /laas/v1/metadata (IEEE 1876 §4.2, diseño §7.4)', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => ENV_KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; }));
  afterEach(() => ENV_KEYS.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]))));

  // Dispositivos registrados con datos que NO deben aparecer en el documento público.
  const DEVICES = [
    { id: '11111111-2222-4333-8444-555555555555', name: 'Hioki del laboratorio B', type: 'hioki-im3570', ip: '10.9.8.7', projectId: '99999999-8888-4777-8666-555555555555', status: 'online' },
    { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'MUX secreto', type: 'kronos-mux-16', ip: '10.9.8.6', projectId: '99999999-8888-4777-8666-555555555555', status: 'online' },
  ];
  const prisma = {
    device: { findMany: jest.fn(async () => DEVICES), findFirst: jest.fn(async () => DEVICES[0]) },
    measurement: { findFirst: jest.fn(), groupBy: jest.fn() },
  };

  async function controller() {
    const moduleRef = await Test.createTestingModule({
      controllers: [LaasMetadataController],
      providers: [
        LaasMetadataService,
        LaasCatalog,
        { provide: DEVICE_MODEL_DEFINITIONS, useValue: DEVICE_MODELS },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    return moduleRef.get(LaasMetadataController);
  }

  it('contiene los campos de las Tablas 1, 2, 3, 4, 5, 6, 7 y 9', async () => {
    const doc = (await controller()).getMetadata() as any;
    // Tabla 1
    for (const f of ['title', 'description', 'termsOfServiceURL', 'contact', 'license', 'licenseUrl']) {
      expect(typeof doc[f]).toBe('string');
      expect(doc[f]).not.toBe('');
    }
    // Tabla 2
    expect(doc.basePath).toBe(DEFAULT_LAAS_BASE_URL);
    expect(Array.isArray(doc.apis)).toBe(true);
    expect(Array.isArray(doc.models)).toBe(true);
    // Tabla 3
    for (const api of doc.apis) {
      expect(Object.keys(api).sort()).toEqual(['identifier', 'operations', 'produces', 'protocol']);
      expect(api).toMatchObject({ protocol: 'http', produces: 'application/json' });
      // Tabla 4
      for (const op of api.operations) {
        for (const f of ['method', 'nickname', 'summary', 'notes', 'type', 'parameters', 'responseMessages']) expect(op).toHaveProperty(f);
        expect(typeof op.responseMessages).toBe('string');
        // Tabla 5
        for (const p of op.parameters) expect(Object.keys(p).sort()).toEqual(['description', 'name', 'paramType', 'required']);
        // Extensiones propias siempre con x-
        for (const k of Object.keys(op)) {
          expect(['method', 'nickname', 'summary', 'notes', 'type', 'items', 'parameters', 'responseMessages'].includes(k) || k.startsWith('x-')).toBe(true);
        }
      }
    }
    expect(doc.apis.find((a: any) => a.identifier === '/sensors/{sensorId}/data').operations[0].parameters[0])
      .toEqual({ name: 'sensorId', description: expect.any(String), required: true, paramType: 'path' });
    // Tabla 6
    for (const m of doc.models) expect(Object.keys(m).sort()).toEqual(['id', 'properties', 'required']);
    // Tabla 7
    expect(doc.authorization).toEqual({ authorizationType: 'SSO protocol', keyName: 'Authorization', authServiceUrl: '/auth/v1' });
    // Tabla 9
    expect(doc.concurrency).toEqual({ interactionMode: 'asynchronous' });
  });

  it('publica una operación por cada servicio del estándar (§4.3) con su nickname', async () => {
    const doc = (await controller()).getMetadata();
    const nicknames = doc.apis.flatMap((a) => a.operations.map((o) => o.nickname));
    for (const n of ['getSensorMetadata', 'getSensorData', 'getActuatorMetadata', 'setActuatorData', 'getConfiguration', 'setConfiguration', 'getExperiment', 'getClients']) {
      expect(nicknames).toContain(n);
    }
    expect(new Set(nicknames).size).toBe(nicknames.length);
    expect(doc.apis.map((a) => a.identifier)).toEqual([...new Set(LAAS_OPERATIONS.map((o) => o.identifier))]);
  });

  it('modelos coherentes: required ⊆ properties y cada type/items/$ref apunta a un modelo', async () => {
    const doc = (await controller()).getMetadata();
    const ids = new Set(doc.models.map((m) => m.id));
    expect(ids.size).toBe(LAAS_MODELS.length);
    for (const m of doc.models) {
      for (const r of m.required) expect(Object.keys(m.properties)).toContain(r);
      for (const p of Object.values(m.properties)) {
        if (p.$ref) expect(ids).toContain(p.$ref);
        if (p.items && '$ref' in p.items) expect(ids).toContain(p.items.$ref);
      }
    }
    for (const op of doc.apis.flatMap((a) => a.operations)) {
      if (op.type === 'array') expect(ids).toContain(op.items!.$ref);
      else expect(ids).toContain(op.type);
    }
    for (const id of ['SensorDataJob', 'ActuatorDataRequest', 'ConfigurationRequest']) expect(ids).toContain(id);
  });

  it('Tabla 1, basePath y authServiceUrl desde el entorno', async () => {
    Object.assign(process.env, {
      LAAS_TITLE: 'Lab X', LAAS_DESCRIPTION: 'Desc X', LAAS_TERMS_URL: 'https://x/terms', LAAS_CONTACT: 'x@x.org',
      LAAS_LICENSE: 'CC-BY 4.0', LAAS_LICENSE_URL: 'https://x/license', LAAS_BASE_URL: 'https://api.x/laas/v1', SUPABASE_URL: 'https://sb.x',
    });
    const doc = (await controller()).getMetadata();
    expect(doc).toMatchObject({
      title: 'Lab X', description: 'Desc X', termsOfServiceURL: 'https://x/terms', contact: 'x@x.org',
      license: 'CC-BY 4.0', licenseUrl: 'https://x/license', basePath: 'https://api.x/laas/v1',
      authorization: { authServiceUrl: 'https://sb.x/auth/v1' },
    });
  });

  it('x-kronos: modelos del catálogo (sin hardcodear) y eventos', async () => {
    const doc = (await controller()).getMetadata();
    expect(doc['x-kronos'].deviceModels.map((m) => m.deviceType)).toEqual(DEVICE_MODELS.map((m) => m.description.deviceType));
    expect(doc['x-kronos'].deviceModels.find((m) => m.deviceType === 'kronos-mux-16')!.role).toBe('channel-selector');
    expect(doc['x-kronos'].events).toMatchObject({ namespace: '/measurements', progress: 'measurement:progress' });
  });

  it('no contiene datos de instancias aunque existan dispositivos (ni consulta la base)', async () => {
    const json = JSON.stringify((await controller()).getMetadata());
    for (const d of DEVICES) {
      for (const value of [d.id, d.name, d.ip, d.projectId]) expect(json).not.toContain(value);
    }
    expect(prisma.device.findMany).not.toHaveBeenCalled();
    expect(prisma.device.findFirst).not.toHaveBeenCalled();
  });

  it('metadata y getClients son públicos (sin guards); getClients devuelve FRONTEND_URL', async () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, LaasMetadataController)).toBeUndefined();
    for (const handler of ['getMetadata', 'getClients'] as const) {
      expect(Reflect.getMetadata(GUARDS_METADATA, LaasMetadataController.prototype[handler])).toBeUndefined();
    }
    process.env.FRONTEND_URL = 'https://kronos.example.org';
    expect((await controller()).getClients()).toEqual([{ name: 'Kronos', url: 'https://kronos.example.org' }]);
  });
});
