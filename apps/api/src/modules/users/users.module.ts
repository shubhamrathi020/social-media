import { Module } from '@nestjs/common';
import { FriendsModule } from '../friends/friends.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [FriendsModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
