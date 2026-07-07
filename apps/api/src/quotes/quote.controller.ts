import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  QuoteService,
  type CreateQuoteInput,
  type QuoteView,
} from './quote.service';

@Controller('quotes')
export class QuoteController {
  constructor(private readonly quotes: QuoteService) {}

  @Post()
  create(@Body() body: CreateQuoteInput): Promise<QuoteView> {
    return this.quotes.createQuote(body);
  }

  @Get(':id')
  getOne(@Param('id') id: string): Promise<QuoteView> {
    return this.quotes.getQuoteView(id);
  }
}
