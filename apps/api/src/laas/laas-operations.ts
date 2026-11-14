/**
 * Mapa declarativo de los servicios LaaS (IEEE Std 1876-2019 §4.2.2/§4.3) publicados en /laas/v1.
 * Fuente única de verdad: el documento de metadatos (`apis`, `models`) se genera de aquí y los
 * controllers toman sus permisos de aquí (`permissionOf`); un spec comprueba que cada ruta de los
 * controllers tiene su operación y viceversa.
 *
 * Nombres de campo exactamente como en las Tablas 3–6 del estándar. Extensiones Kronos con `x-`.
 * `paramType` se publica como texto (`path`/`query`/`body`) (diseño §7.4/§9). Listas: `type: 'array'`
 * con `items: { $ref }` (convención Swagger 1.2, de la que derivan las Tablas 2–6).
 */

export const LAAS_PROTOCOL = 'http';
export const LAAS_PRODUCES = 'application/json';

/** Tabla 5 */
export interface LaasParameter {
  name: string;
  description: string;
  required: boolean;
  paramType: 'path' | 'query' | 'body';
}

/** Tabla 4 (+ `identifier` de la Tabla 3 para agrupar y `x-permission`). */
export interface LaasOperationDefinition {
  identifier: string;
  method: 'GET' | 'PUT';
  nickname: string;
  summary: string;
  notes: string;
  type: string;
  items?: { $ref: string };
  parameters: LaasParameter[];
  responseMessages: string;
  /** Permiso exigido; `null` = público (sin login). */
  'x-permission': string | null;
}

/** Propiedad de un modelo (Tabla 6 `properties`). */
export interface LaasModelProperty {
  type: 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  items?: { type: string } | { $ref: string };
  $ref?: string;
}

/** Tabla 6 */
export interface LaasModel {
  id: string;
  required: string[];
  properties: Record<string, LaasModelProperty>;
}

/** getSensorData con `fresh=true` encola una medición: exige además este permiso. */
export const FRESH_SENSOR_DATA_PERMISSION = 'measurement:execute';

const AUTH_NOTE = 'Requiere `Authorization: Bearer <token>` (sesión de Supabase o JWT propio de POST /auth/login)';
const authNote = (permission: string) => `${AUTH_NOTE} y el permiso \`${permission}\`.`;
const SCOPE_NOTE = 'Solo equipos no archivados de los proyectos del equipo de trabajo del usuario.';

const path = (name: string, description: string): LaasParameter => ({ name, description, required: true, paramType: 'path' });
const query = (name: string, description: string): LaasParameter => ({ name, description, required: false, paramType: 'query' });
const body = (model: string): LaasParameter => ({ name: 'body', description: `Cuerpo JSON (modelo ${model})`, required: true, paramType: 'body' });

const SENSOR_ID = path('sensorId', 'Id LaaS del sensor: `<deviceId>:<sensorId del catálogo>`');
const ACTUATOR_ID = path('actuatorId', 'Id LaaS del actuador: `<deviceId>:<actuatorId del catálogo>`');
const DEVICE_ID = path('deviceId', 'Id (uuid) del dispositivo registrado');
const DEVICE_FILTER = query('deviceId', 'Filtra por un dispositivo (uuid)');

export const LAAS_OPERATIONS: readonly LaasOperationDefinition[] = [
  {
    identifier: '/metadata',
    method: 'GET',
    nickname: 'getMetadata',
    summary: 'Metadatos del laboratorio (servicio de metadatos)',
    notes: 'Público. Describe el laboratorio, sus servicios, modelos, autorización y concurrencia; no contiene datos de equipos concretos.',
    type: 'Metadata',
    parameters: [],
    responseMessages: '200 Metadata',
    'x-permission': null,
  },
  {
    identifier: '/sensors',
    method: 'GET',
    nickname: 'getSensorMetadata',
    summary: 'Sensores disponibles (Tabla 14) por instancia',
    notes: `Un elemento por sensor de cada equipo de medición, con sensorConfiguration (Tabla 16) y lastMeasured. ${SCOPE_NOTE} ${authNote('device:view')}`,
    type: 'array',
    items: { $ref: 'Sensor' },
    parameters: [DEVICE_FILTER],
    responseMessages: '200 Sensor[]; 400 deviceId inválido; 401 sin sesión; 403 sin permiso; 404 dispositivo no encontrado',
    'x-permission': 'device:view',
  },
  {
    identifier: '/sensors/{sensorId}/data',
    method: 'GET',
    nickname: 'getSensorData',
    summary: 'Última lectura del sensor, o una lectura nueva con fresh=true',
    notes:
      'Sin fresh: la última medición tomada con ese equipo y sensor (de cualquier tarea del equipo de trabajo, o de taskId), con todos sus canales. ' +
      'Con fresh=true: encola una medición de la tarea taskId (que debe usar ese equipo como sensor) con los rangos de su configuración y los canales indicados ' +
      '(por defecto todos los del experimento); responde 202 SensorDataJob y el progreso/resultado llega por los eventos de x-kronos.events. ' +
      `${authNote('measurement:view')} Con fresh=true además \`${FRESH_SENSOR_DATA_PERMISSION}\`.`,
    type: 'SensorData',
    parameters: [
      SENSOR_ID,
      query('taskId', 'Tarea (entero). Filtra la última lectura; obligatoria con fresh=true'),
      query('fresh', '`true` para pedir una lectura nueva'),
      query('channels', 'Con fresh=true: canales separados por comas (p. ej. 1,2)'),
    ],
    responseMessages:
      '200 SensorData; 202 SensorDataJob (fresh=true); 400 id/parámetros inválidos o la tarea no usa ese sensor; 401; 403; 404 sensor, tarea o lecturas no encontrados; 409 cola llena o choque con una medición programada',
    'x-permission': 'measurement:view',
  },
  {
    identifier: '/actuators',
    method: 'GET',
    nickname: 'getActuatorMetadata',
    summary: 'Actuadores disponibles (Tabla 19) por instancia',
    notes: `Un elemento por actuador de cada equipo. ${SCOPE_NOTE} ${authNote('device:view')}`,
    type: 'array',
    items: { $ref: 'Actuator' },
    parameters: [DEVICE_FILTER],
    responseMessages: '200 Actuator[]; 400 deviceId inválido; 401; 403; 404 dispositivo no encontrado',
    'x-permission': 'device:view',
  },
  {
    identifier: '/actuators/{actuatorId}/data',
    method: 'PUT',
    nickname: 'setActuatorData',
    summary: 'Aplica valores a un actuador',
    notes:
      'Los valores se validan contra rangeMinimum/rangeMaximum/rangeStep de sus actuatorValues antes de tocar el equipo (§4.4.1). ' +
      `Rechazado mientras el equipo mide. ${authNote('device:edit')}`,
    type: 'ActuatorData',
    parameters: [ACTUATOR_ID, body('ActuatorDataRequest')],
    responseMessages: '200 ActuatorData; 400 cuerpo inválido o valor fuera de rango; 401; 403; 404 actuador no encontrado; 409 equipo ocupado; 502 el equipo rechazó el valor; 504 el laboratorio no respondió a tiempo',
    'x-permission': 'device:edit',
  },
  {
    identifier: '/configuration/{deviceId}',
    method: 'GET',
    nickname: 'getConfiguration',
    summary: 'Configuración actual de un dispositivo',
    notes: `Parámetros configurables declarados por el modelo con su valor actual (mismo cuerpo que GET /devices/:id/configuration). ${authNote('device:view')}`,
    type: 'Configuration',
    parameters: [DEVICE_ID],
    responseMessages: '200 Configuration; 400 deviceId inválido; 401; 403; 404 dispositivo no encontrado',
    'x-permission': 'device:view',
  },
  {
    identifier: '/configuration/{deviceId}',
    method: 'PUT',
    nickname: 'setConfiguration',
    summary: 'Cambia la configuración de un dispositivo',
    notes: `Igual que PUT /devices/:id/configuration: valida, aplica en vivo y/o guarda. ${authNote('device:edit')}`,
    type: 'Configuration',
    parameters: [DEVICE_ID, body('ConfigurationRequest')],
    responseMessages: '200 Configuration; 400 valores inválidos; 401; 403; 404 dispositivo no encontrado; 409 equipo ocupado; 502 el equipo rechazó el valor; 504 el laboratorio no respondió a tiempo',
    'x-permission': 'device:edit',
  },
  {
    identifier: '/experiments',
    method: 'GET',
    nickname: 'getExperiment',
    summary: 'Experimentos (Tabla 20)',
    notes: `Sin projectId: experimentos del catálogo con ids de sensores/actuadores del catálogo. Con projectId: ids LaaS de las instancias del proyecto. ${authNote('device:view')}`,
    type: 'array',
    items: { $ref: 'Experiment' },
    parameters: [query('projectId', 'Proyecto (uuid) cuyas instancias se listan')],
    responseMessages: '200 Experiment[]; 401; 403; 404 proyecto no encontrado',
    'x-permission': 'device:view',
  },
  {
    identifier: '/clients',
    method: 'GET',
    nickname: 'getClients',
    summary: 'Aplicaciones cliente del laboratorio',
    notes: 'Público.',
    type: 'array',
    items: { $ref: 'Client' },
    parameters: [],
    responseMessages: '200 Client[]',
    'x-permission': null,
  },
];

const str = (description: string): LaasModelProperty => ({ type: 'string', description });
const int = (description: string): LaasModelProperty => ({ type: 'integer', description });
const num = (description: string): LaasModelProperty => ({ type: 'number', description });
const bool = (description: string): LaasModelProperty => ({ type: 'boolean', description });
const obj = (description: string): LaasModelProperty => ({ type: 'object', description });
const ref = ($ref: string, description: string): LaasModelProperty => ({ type: 'object', description, $ref });
const listOf = ($ref: string, description: string): LaasModelProperty => ({ type: 'array', description, items: { $ref } });
const strings = (description: string): LaasModelProperty => ({ type: 'array', description, items: { type: 'string' } });

const configurationElement = (id: string, table: string): LaasModel => ({
  id,
  required: ['parameter', 'description', 'type'],
  properties: {
    parameter: str(`Nombre del parámetro (${table})`),
    description: str('Descripción del parámetro'),
    type: str('Tipo primitivo o array'),
    items: str('Tipo de los elementos si type es array'),
    'x-unit': str('Unidad (extensión Kronos)'),
    'x-rangeMinimum': num('Mínimo admitido (extensión Kronos)'),
    'x-rangeMaximum': num('Máximo admitido (extensión Kronos)'),
    'x-allowedValues': strings('Valores admitidos (extensión Kronos)'),
  },
});

export const LAAS_MODELS: readonly LaasModel[] = [
  {
    id: 'Metadata',
    required: ['title', 'description', 'basePath', 'apis', 'models', 'authorization', 'concurrency'],
    properties: {
      title: str('Tabla 1'),
      description: str('Tabla 1'),
      termsOfServiceURL: str('Tabla 1 (URI)'),
      contact: str('Tabla 1 (e-mail)'),
      license: str('Tabla 1'),
      licenseUrl: str('Tabla 1 (URI)'),
      basePath: str('Tabla 2 (URI)'),
      apis: { type: 'array', description: 'Tabla 2/3: ServiceDescription[]', items: { type: 'object' } },
      models: { type: 'array', description: 'Tabla 2/6: Model[]', items: { type: 'object' } },
      authorization: obj('Tabla 7'),
      concurrency: obj('Tabla 9'),
      'x-kronos': obj('Extensión Kronos: modelos de dispositivo del catálogo y eventos en tiempo real'),
    },
  },
  {
    id: 'Sensor',
    required: ['sensorId', 'fullName', 'description', 'protocol', 'produces', 'sensorValues', 'sensorConfiguration', 'accessMode'],
    properties: {
      sensorId: str('Id LaaS `<deviceId>:<sensorId del catálogo>`'),
      fullName: str('Nombre completo del sensor'),
      description: str('Descripción'),
      protocol: str('Protocolo con el que el cliente lo alcanza (http)'),
      produces: str('MIME de los datos'),
      sensorValues: listOf('SensorValue', 'Tabla 15'),
      sensorConfiguration: listOf('SensorConfiguration', 'Tabla 16'),
      accessMode: ref('AccessMode', 'Tablas 17/18'),
      'x-deviceProtocol': str('Protocolo entre el laboratorio y el equipo (tcp, http, simulated)'),
      'x-acquisition': obj('Adquisición declarada: sweep (variable, puntos, escalas) o single'),
      'x-device': ref('Device', 'Equipo registrado al que pertenece'),
    },
  },
  {
    id: 'SensorValue',
    required: ['name', 'unit', 'type'],
    properties: {
      name: str('Nombre'),
      unit: str('Unidad'),
      type: str('Tipo primitivo'),
      lastMeasured: str('Fecha ISO-8601 de la última medición con este equipo y sensor'),
      rangeMinimum: num('Mínimo'),
      rangeMaximum: num('Máximo'),
      rangeStep: num('Paso'),
      updateFrequency: num('Hz'),
      'x-label': str('Texto para leyendas (extensión Kronos)'),
    },
  },
  configurationElement('SensorConfiguration', 'Tabla 16'),
  {
    id: 'AccessMode',
    required: ['accessModeType'],
    properties: {
      accessModeType: str('pull | push | stream (Tabla 18)'),
      nominalUpdateInterval: num('Solo push'),
      userModifiableFrequency: bool('Solo push'),
    },
  },
  {
    id: 'Device',
    required: ['id', 'name', 'deviceType', 'projectId', 'status'],
    properties: {
      id: str('uuid del dispositivo'),
      name: str('Nombre'),
      deviceType: str('Modelo del catálogo'),
      projectId: str('uuid del proyecto'),
      status: str('online | offline'),
    },
  },
  {
    id: 'SensorData',
    required: ['sensorId', 'measurementId', 'taskId', 'lastMeasured', 'acquisition', 'sensorValues', 'channels'],
    properties: {
      sensorId: str('Id LaaS del sensor'),
      measurementId: int('Medición'),
      taskId: int('Tarea de la medición'),
      lastMeasured: str('Fecha ISO-8601 de la medición'),
      acquisition: obj('{ kind: sweep, variable } | { kind: single }'),
      sensorValues: { type: 'array', description: '[{ name, unit, label? }]', items: { type: 'object' } },
      channels: listOf('SensorDataChannel', 'Un elemento por canal medido'),
    },
  },
  {
    id: 'SensorDataChannel',
    required: ['channel', 'points'],
    properties: {
      channel: int('Número de canal'),
      points: { type: 'array', description: '[{ x?, values: { <sensorValue>: número } }] (x ausente en lecturas puntuales)', items: { type: 'object' } },
    },
  },
  {
    id: 'SensorDataJob',
    required: ['jobId', 'taskId', 'estimatedSeconds'],
    properties: {
      jobId: str('Id del job de medición (eventos job:status / measurement:*)'),
      taskId: int('Tarea'),
      estimatedSeconds: int('Duración estimada'),
    },
  },
  {
    id: 'Actuator',
    required: ['actuatorId', 'fullName', 'description', 'protocol', 'inputType', 'actuatorValues', 'actuatorConfiguration', 'accessMode'],
    properties: {
      actuatorId: str('Id LaaS `<deviceId>:<actuatorId del catálogo>`'),
      fullName: str('Nombre completo del actuador'),
      description: str('Descripción'),
      protocol: str('Protocolo con el que el cliente lo alcanza (http)'),
      inputType: str('Tipo de dato aceptado'),
      actuatorValues: listOf('ActuatorValue', 'Valores de entrada'),
      actuatorConfiguration: listOf('ActuatorConfiguration', 'Configuración del actuador (la del equipo se expone en getConfiguration)'),
      accessMode: ref('AccessMode', 'Tablas 17/18'),
      'x-deviceProtocol': str('Protocolo entre el laboratorio y el equipo (tcp, http, simulated)'),
      'x-device': ref('Device', 'Equipo registrado al que pertenece'),
    },
  },
  {
    id: 'ActuatorValue',
    required: ['name', 'unit', 'type'],
    properties: {
      name: str('Nombre'),
      unit: str('Unidad'),
      type: str('Tipo primitivo'),
      rangeMinimum: num('Mínimo admitido'),
      rangeMaximum: num('Máximo admitido'),
      rangeStep: num('Paso admitido'),
    },
  },
  configurationElement('ActuatorConfiguration', 'Tabla 16 aplicada a actuadores'),
  {
    id: 'ActuatorDataRequest',
    required: ['values'],
    properties: { values: obj('{ <nombre del actuatorValue>: número } (al menos uno)') },
  },
  {
    id: 'ActuatorData',
    required: ['actuatorId', 'values', 'appliedAt'],
    properties: {
      actuatorId: str('Id LaaS del actuador'),
      values: obj('Valores aplicados'),
      appliedAt: str('Fecha ISO-8601'),
    },
  },
  {
    id: 'Configuration',
    required: ['deviceId', 'deviceType', 'busy', 'parameters'],
    properties: {
      deviceId: str('uuid del dispositivo'),
      deviceType: str('Modelo del catálogo'),
      busy: bool('true si está midiendo o configurándose'),
      parameters: listOf('ConfigurationParameter', 'Parámetros declarados con su valor actual'),
    },
  },
  {
    id: 'ConfigurationParameter',
    required: ['name', 'label', 'type', 'unit', 'access', 'storage', 'value'],
    properties: {
      name: str('Nombre'),
      label: str('Etiqueta'),
      description: str('Descripción'),
      type: str('Tipo primitivo'),
      unit: str('Unidad'),
      rangeMinimum: num('Mínimo'),
      rangeMaximum: num('Máximo'),
      rangeStep: num('Paso'),
      allowedValues: strings('Valores admitidos'),
      default: str('Valor por defecto'),
      access: str('read-only | read-write'),
      storage: str('fixed | persisted | live'),
      value: str('Valor actual (null si no se conoce)'),
    },
  },
  {
    id: 'ConfigurationRequest',
    required: ['values'],
    properties: { values: obj('{ <nombre del parámetro>: valor }') },
  },
  {
    id: 'Experiment',
    required: ['experimentId', 'fullName', 'description', 'sensors', 'actuators'],
    properties: {
      experimentId: str('Id del experimento'),
      fullName: str('Nombre'),
      description: str('Descripción'),
      sensors: strings('Ids de sensores (LaaS con projectId, de catálogo sin él)'),
      actuators: strings('Ids de actuadores (LaaS con projectId, de catálogo sin él)'),
      'x-sensorType': str('Modelo del equipo de medición'),
      'x-channelSelectorType': str('Modelo del selector de canal (o null)'),
      'x-channelRange': obj('{ min, max } canales medibles'),
      'x-acquisition': obj('Adquisición del equipo de medición'),
      'x-simulated': bool('true si el equipo de medición es simulado'),
      'x-available': bool('Con projectId: hay dispositivos para cada lugar'),
    },
  },
  {
    id: 'Client',
    required: ['name', 'url'],
    properties: { name: str('Nombre de la aplicación'), url: str('URL') },
  },
];

/** Operación por nickname (lanza si no existe: los controllers la usan en decoradores al cargar). */
export function operationOf(nickname: string): LaasOperationDefinition {
  const op = LAAS_OPERATIONS.find((o) => o.nickname === nickname);
  if (!op) throw new Error(`Operación LaaS desconocida: "${nickname}"`);
  return op;
}

/** Permiso de una operación autenticada (para @RequirePermission). */
export function permissionOf(nickname: string): string {
  const permission = operationOf(nickname)['x-permission'];
  if (!permission) throw new Error(`La operación LaaS "${nickname}" es pública`);
  return permission;
}
