const producer = kafka.producer();
producer.send({ topic: "order.created", messages: [] });

const program = new Command();
program.command("migrate").action(() => {});

io.on("orderUpdated", (data) => {});

app.post("/admin/dangerous", requireRole("superadmin"), (req, res) => {});
