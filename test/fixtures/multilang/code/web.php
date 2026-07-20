<?php
Route::get('/api/invoices', [InvoiceController::class, 'index']);
Route::post('/api/invoices', [InvoiceController::class, 'store']);
