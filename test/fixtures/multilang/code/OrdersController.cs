public class OrdersController {
    [HttpGet("/api/orders")]
    public IActionResult GetOrders() { return Ok(); }
}
