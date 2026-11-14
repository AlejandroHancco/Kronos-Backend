import { Controller, Get } from '@nestjs/common';
import { LaasMetadataService, laasClients } from './laas-metadata.service';

/**
 * Servicios públicos de /laas/v1 (sin guards de autenticación): metadatos (IEEE 1876 §4.3.3) y
 * getClients (§4.3.2). Ninguno expone instancias de dispositivos.
 */
@Controller('laas/v1')
export class LaasMetadataController {
  constructor(private readonly metadata: LaasMetadataService) {}

  @Get('metadata')
  getMetadata() {
    return this.metadata.document();
  }

  @Get('clients')
  getClients() {
    return laasClients();
  }
}
