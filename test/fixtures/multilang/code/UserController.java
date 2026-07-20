@RestController
public class UserController {
    @GetMapping("/api/users/{id}")
    public User getUser(@PathVariable String id) { return null; }

    @RequestMapping(value = "/api/users", method = RequestMethod.POST)
    public User createUser() { return null; }
}
