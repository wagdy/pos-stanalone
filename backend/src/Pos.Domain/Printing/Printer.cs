using Pos.Domain.Catalog;
using Pos.Domain.Common;

namespace Pos.Domain.Printing;

// How a printer is reached.
public enum PrinterConnection
{
    // The browser's own print dialog on the terminal, an 80 mm page (silent in a kiosk browser
    // started with --kiosk-printing).
    Browser = 1,

    // A thermal printer on the network, sent ESC/POS on its raw port (9100).
    Network = 2,
}

public enum PrinterRole
{
    // The till's: checks, receipts, the Z report.
    Cashier = 1,

    // A kitchen station's: its tickets.
    Kitchen = 2,
}

// A printer (طابعة): the cashier's, or a kitchen station's, and how it is reached.
public sealed class Printer : AggregateRoot
{
    private Printer() { }

    public Printer(Guid id, string name, PrinterConnection connection, PrinterRole role, string? host, int port, int charactersPerLine)
    {
        Id = id;
        Update(name, connection, role, host, port, charactersPerLine, true);
    }

    public string Name { get; private set; } = string.Empty;
    public PrinterConnection Connection { get; private set; }
    public PrinterRole Role { get; private set; }
    public string? Host { get; private set; }
    public int Port { get; private set; } = 9100;

    // 48 on an 80 mm roll, 32 on a 58 mm one.
    public int CharactersPerLine { get; private set; } = 48;
    public bool IsActive { get; private set; } = true;

    public void Update(string name, PrinterConnection connection, PrinterRole role, string? host, int port, int charactersPerLine, bool isActive)
    {
        if (!Enum.IsDefined(connection) || !Enum.IsDefined(role))
            throw new DomainException("Choose how the printer is reached and what it prints.");
        var address = host?.Trim();
        if (connection == PrinterConnection.Network && string.IsNullOrEmpty(address))
            throw new DomainException("Enter the printer's IP address: 192.168.1.50. · عنوان الطابعة.");
        if (port is < 1 or > 65535)
            throw new DomainException("The port is 1 to 65535: 9100 for most thermal printers.");
        if (charactersPerLine is < 24 or > 64)
            throw new DomainException("A line holds 24 to 64 characters: 48 on 80 mm, 32 on 58 mm.");
        Name = Names.Required(name, 80, "Name the printer: Cashier, Grill. · اسم الطابعة.");
        Connection = connection;
        Role = role;
        Host = connection == PrinterConnection.Network ? address : null;
        Port = port;
        CharactersPerLine = charactersPerLine;
        IsActive = isActive;
    }
}

public interface IPrinterRepository : IRepository<Printer>
{
    Task<IReadOnlyList<Printer>> GetAllAsync(CancellationToken cancellationToken = default);

    void Remove(Printer printer);
}
