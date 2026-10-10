import { Module } from '@nestjs/common';
import { AccountModule } from '../account/account.module';
import { MaintenanceService } from './maintenance.service';

@Module({ imports: [AccountModule], providers: [MaintenanceService] })
export class MaintenanceModule {}
