import { Module } from '@nestjs/common';
import { DispatchController } from './dispatch.controller';
import { DispatchService } from './dispatch.service';
import { RepeatLiquidityService } from './repeat-liquidity.service';

// SCRUM-242 dispatch-lite matching + bilateral repeat-liquidity instrumentation.
// Ports (repository, clock, env) come from the global CoreModule.
@Module({
  controllers: [DispatchController],
  providers: [DispatchService, RepeatLiquidityService],
  exports: [DispatchService, RepeatLiquidityService],
})
export class DispatchModule {}
