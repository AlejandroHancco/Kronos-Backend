import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/database';
import { ExperimentsModule } from '@app/experiments';
import { SeriesReservationsService } from './series-reservations.service';

/**
 * Solo las reservas de series (sin drivers ni ejecutor): la API lo importa directamente; el
 * worker lo recibe a través de MeasurementModule, que lo re-exporta.
 */
@Module({
  imports: [PrismaModule, ExperimentsModule],
  providers: [SeriesReservationsService],
  exports: [SeriesReservationsService],
})
export class SeriesReservationsModule {}
