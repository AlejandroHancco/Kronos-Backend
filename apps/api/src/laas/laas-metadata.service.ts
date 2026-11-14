import { Injectable } from '@nestjs/common';
import { DeviceRole, DeviceServiceDescription, LaasCatalog } from '@app/laas-catalog';
import {
  LAAS_MODELS,
  LAAS_OPERATIONS,
  LAAS_PRODUCES,
  LAAS_PROTOCOL,
  LaasModel,
  LaasOperationDefinition,
} from './laas-operations';

/** Tabla 3 */
export interface LaasServiceDescription {
  identifier: string;
  protocol: string;
  produces: string;
  operations: Omit<LaasOperationDefinition, 'identifier'>[];
}

/** Documento de metadatos (diseño §7.4): Tablas 1, 2, 7 y 9 + extensión `x-kronos`. */
export interface LaasMetadataDocument {
  title: string;
  description: string;
  termsOfServiceURL: string;
  contact: string;
  license: string;
  licenseUrl: string;
  basePath: string;
  apis: LaasServiceDescription[];
  models: LaasModel[];
  authorization: { authorizationType: 'SSO protocol'; keyName: string; authServiceUrl: string };
  concurrency: { interactionMode: 'asynchronous' };
  'x-kronos': {
    deviceModels: Array<{ role: DeviceRole } & DeviceServiceDescription>;
    events: Record<string, unknown>;
  };
}

export const DEFAULT_LAAS_BASE_URL = 'http://localhost:3000/laas/v1';
const frontendUrl = () => process.env.FRONTEND_URL || 'http://localhost:5173';

/** Cliente oficial publicado por getClients. */
export const laasClients = () => [{ name: 'Kronos', url: frontendUrl() }];

/**
 * Servicio de metadatos (IEEE 1876 §4.3.3). Se genera en cada petición a partir del catálogo, del
 * mapa declarativo de operaciones y del entorno; nunca consulta la base: no contiene instancias.
 */
@Injectable()
export class LaasMetadataService {
  constructor(private readonly catalog: LaasCatalog) {}

  document(): LaasMetadataDocument {
    const env = process.env;
    const termsOfServiceURL = env.LAAS_TERMS_URL || frontendUrl();
    return {
      title: env.LAAS_TITLE || 'Kronos LaaS',
      description:
        env.LAAS_DESCRIPTION ||
        'Laboratorio en línea Kronos (IEEE Std 1876-2019, Lab as a Service): sensores, actuadores y experimentos de los equipos de su catálogo, operados de forma asíncrona.',
      termsOfServiceURL,
      contact: env.LAAS_CONTACT || 'kronos@localhost',
      license: env.LAAS_LICENSE || 'Todos los derechos reservados',
      licenseUrl: env.LAAS_LICENSE_URL || termsOfServiceURL,
      basePath: env.LAAS_BASE_URL || DEFAULT_LAAS_BASE_URL,
      apis: this.apis(),
      models: LAAS_MODELS.map((m) => ({ ...m, required: [...m.required], properties: { ...m.properties } })),
      authorization: {
        authorizationType: 'SSO protocol',
        keyName: 'Authorization',
        authServiceUrl: `${env.SUPABASE_URL ?? ''}/auth/v1`,
      },
      concurrency: { interactionMode: 'asynchronous' },
      'x-kronos': {
        deviceModels: this.catalog.catalog().map((e) => ({ role: e.role, ...e.service })),
        events: {
          namespace: '/measurements',
          room: '<userId>',
          progress: 'measurement:progress',
          completed: 'measurement:completed',
          error: 'measurement:error',
          jobStatus: { namespace: '/kronos', room: 'user:<userId>', event: 'job:status' },
        },
      },
    };
  }

  /** Tabla 3: una entrada por ruta, con sus operaciones (Tabla 4) en el orden del mapa. */
  private apis(): LaasServiceDescription[] {
    const byIdentifier = new Map<string, LaasServiceDescription>();
    for (const { identifier, ...operation } of LAAS_OPERATIONS) {
      let api = byIdentifier.get(identifier);
      if (!api) {
        api = { identifier, protocol: LAAS_PROTOCOL, produces: LAAS_PRODUCES, operations: [] };
        byIdentifier.set(identifier, api);
      }
      api.operations.push(operation);
    }
    return [...byIdentifier.values()];
  }
}
