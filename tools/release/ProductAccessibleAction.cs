using System;
using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;

public sealed class AIbrowseMsaaActionMetadata
{
    public int HResult { get; set; }
    public string Name { get; set; }
    public int Role { get; set; }
    public int State { get; set; }
    public string DefaultAction { get; set; }
}

public static class AIbrowseMsaaAction
{
    const uint ObjectIdClient = 0xFFFFFFFC;
    const int RoleSystemPushButton = 43;
    const int StateSystemUnavailable = 1;

    [DllImport("oleacc.dll")]
    static extern int AccessibleObjectFromWindow(
        IntPtr window,
        uint objectId,
        ref Guid interfaceId,
        out IntPtr accessible);

    static object Open(IntPtr window, out int hresult)
    {
        if (window == IntPtr.Zero) throw new ArgumentException("MSAA动作HWND为空", nameof(window));
        Guid iid = new Guid("618736e0-3c3d-11cf-810c-00aa00389b71");
        IntPtr pointer;
        hresult = AccessibleObjectFromWindow(window, ObjectIdClient, ref iid, out pointer);
        if (hresult < 0) Marshal.ThrowExceptionForHR(hresult);
        if (pointer == IntPtr.Zero) throw new InvalidOperationException("MSAA未返回动作对象");
        try { return Marshal.GetObjectForIUnknown(pointer); }
        finally { Marshal.Release(pointer); }
    }

    static object GetProperty(object accessible, string property)
    {
        return accessible.GetType().InvokeMember(
            property,
            BindingFlags.GetProperty,
            null,
            accessible,
            new object[] { 0 },
            CultureInfo.InvariantCulture);
    }

    static AIbrowseMsaaActionMetadata Read(object accessible, int hresult)
    {
        return new AIbrowseMsaaActionMetadata {
            HResult = hresult,
            Name = Convert.ToString(GetProperty(accessible, "accName"), CultureInfo.InvariantCulture),
            Role = Convert.ToInt32(GetProperty(accessible, "accRole"), CultureInfo.InvariantCulture),
            State = Convert.ToInt32(GetProperty(accessible, "accState"), CultureInfo.InvariantCulture),
            DefaultAction = Convert.ToString(GetProperty(accessible, "accDefaultAction"), CultureInfo.InvariantCulture)
        };
    }

    static void Validate(AIbrowseMsaaActionMetadata metadata, string expectedName)
    {
        if (metadata.HResult != 0 ||
            !String.Equals(metadata.Name, expectedName, StringComparison.Ordinal) ||
            metadata.Role != RoleSystemPushButton ||
            (metadata.State & StateSystemUnavailable) != 0 ||
            String.IsNullOrEmpty(metadata.DefaultAction))
        {
            throw new InvalidOperationException("MSAA动作不满足精确push-button语义资格");
        }
    }

    public static AIbrowseMsaaActionMetadata Inspect(IntPtr window)
    {
        int hresult;
        object accessible = Open(window, out hresult);
        try { return Read(accessible, hresult); }
        finally { if (Marshal.IsComObject(accessible)) Marshal.FinalReleaseComObject(accessible); }
    }

    public static AIbrowseMsaaActionMetadata DoDefaultAction(IntPtr window, string expectedName)
    {
        int hresult;
        object accessible = Open(window, out hresult);
        try {
            AIbrowseMsaaActionMetadata metadata = Read(accessible, hresult);
            Validate(metadata, expectedName);
            accessible.GetType().InvokeMember(
                "accDoDefaultAction",
                BindingFlags.InvokeMethod,
                null,
                accessible,
                new object[] { 0 },
                CultureInfo.InvariantCulture);
            return metadata;
        }
        finally { if (Marshal.IsComObject(accessible)) Marshal.FinalReleaseComObject(accessible); }
    }
}
