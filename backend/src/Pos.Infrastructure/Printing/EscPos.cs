using System.Globalization;
using System.Text;
using Pos.Application.Common;

namespace Pos.Infrastructure.Printing;

public enum PrintJobStatus
{
    Pending = 1,
    Printed = 2,

    // Not printed after every try: the printer is off, out of paper, or not where it was set.
    Failed = 3,
}

// A document on its way to a network printer: its ESC/POS bytes, where they go, and how it went.
public sealed class PrintJob
{
    public const int MaxAttempts = 5;

    private PrintJob() { }

    public PrintJob(Guid id, PrintDocumentKind kind, Guid subjectId, Guid printerId, string printerName, string host, int port, string title, byte[] payload)
    {
        Id = id;
        Kind = kind;
        SubjectId = subjectId;
        PrinterId = printerId;
        PrinterName = printerName;
        Host = host;
        Port = port;
        Title = title.Length > 200 ? title[..200] : title;
        Payload = payload;
        Status = PrintJobStatus.Pending;
        CreatedAtUtc = NextAttemptAtUtc = DateTime.UtcNow;
    }

    public Guid Id { get; private set; }
    public PrintDocumentKind Kind { get; private set; }
    public Guid SubjectId { get; private set; }
    public Guid PrinterId { get; private set; }
    public string PrinterName { get; private set; } = string.Empty;
    public string Host { get; private set; } = string.Empty;
    public int Port { get; private set; }
    public string Title { get; private set; } = string.Empty;
    public byte[] Payload { get; private set; } = [];
    public PrintJobStatus Status { get; private set; }
    public int Attempts { get; private set; }
    public DateTime NextAttemptAtUtc { get; private set; }
    public string? LastError { get; private set; }
    public DateTime CreatedAtUtc { get; private set; }
    public DateTime? PrintedAtUtc { get; private set; }

    public void Printed()
    {
        Status = PrintJobStatus.Printed;
        PrintedAtUtc = DateTime.UtcNow;
        LastError = null;
    }

    public void NotPrinted(string error)
    {
        Attempts++;
        LastError = error.Length > 500 ? error[..500] : error;
        if (Attempts >= MaxAttempts)
            Status = PrintJobStatus.Failed;
        else
            NextAttemptAtUtc = DateTime.UtcNow.AddSeconds(5 * Attempts);
    }

    public void Retry()
    {
        Status = PrintJobStatus.Pending;
        Attempts = 0;
        NextAttemptAtUtc = DateTime.UtcNow;
    }
}

// An ESC/POS document for a thermal printer, written a line at a time: text in the printer's own
// character set (what it cannot print, Arabic among it, left out: the browser prints Arabic), bold,
// double size, white on black for a banner, and the cut at the end.
public sealed class EscPosDocument(int width)
{
    private static readonly Encoding Text = Encoding.Latin1;
    private readonly MemoryStream _bytes = new();

    public int Width { get; } = width;

    public static EscPosDocument Start(int width)
    {
        var document = new EscPosDocument(width);
        document.Raw(0x1B, 0x40);
        return document;
    }

    public EscPosDocument Align(char align)
    {
        Raw(0x1B, 0x61, align switch { 'c' => (byte)1, 'r' => (byte)2, _ => (byte)0 });
        return this;
    }

    public EscPosDocument Bold(bool on)
    {
        Raw(0x1B, 0x45, on ? (byte)1 : (byte)0);
        return this;
    }

    // 1: normal; 2: double height and width; 3: triple.
    public EscPosDocument Size(int times)
    {
        var n = (byte)(Math.Clamp(times, 1, 8) - 1);
        Raw(0x1D, 0x21, (byte)((n << 4) | n));
        return this;
    }

    public EscPosDocument Inverse(bool on)
    {
        Raw(0x1D, 0x42, on ? (byte)1 : (byte)0);
        return this;
    }

    public EscPosDocument Line(string text = "")
    {
        // Arabic and anything else outside the code page goes; a line of nothing else is left out.
        var printable = new string(text.Where(c => c < 256 && !char.IsControl(c)).ToArray()).TrimEnd(' ', '·');
        if (printable.Trim().Length == 0 && text.Trim().Length > 0)
            return this;
        _bytes.Write(Text.GetBytes(printable));
        _bytes.WriteByte(0x0A);
        return this;
    }

    // Left and right on one line: "Subtotal ............ 400.00".
    public EscPosDocument Pair(string left, string right, int width = 0)
    {
        var w = width == 0 ? Width : width;
        var room = Math.Max(1, w - right.Length - 1);
        var l = left.Length > room ? left[..room] : left;
        return Line(l + new string(' ', w - l.Length - right.Length) + right);
    }

    public EscPosDocument Rule(char c = '-') => Line(new string(c, Width));

    public EscPosDocument Feed(int lines = 1)
    {
        Raw(0x1B, 0x64, (byte)Math.Clamp(lines, 0, 10));
        return this;
    }

    public byte[] Cut()
    {
        Feed(4);
        Raw(0x1D, 0x56, 0x42, 0x00);
        return _bytes.ToArray();
    }

    private void Raw(params byte[] bytes) => _bytes.Write(bytes);

    public static string Money(decimal value) => value.ToString("N2", CultureInfo.InvariantCulture);
}
