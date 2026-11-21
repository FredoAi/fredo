# detach-process.psm1 - the ONE handle-whitelist spawn primitive for pipeline
# scripts that start a GUI or a long-lived child (Spec #3181 round 3, guardrail
# G-450; extracted verbatim from launch-artifact-probe.ps1, which used to keep a
# private copy -- the reason a second, inheriting spawn was re-invented in the
# gate's child runner).
#
# WHY: PowerShell 5.1's `Start-Process -RedirectStandardOutput/-RedirectStandardError`
# calls Win32 CreateProcess with handle inheritance ON and NO handle whitelist,
# so the child inherits EVERY inheritable handle of this process -- including the
# stdout/stderr PIPE handles of whoever invoked this script. The launched app's
# WebView2 tree (or a descendant runner) then keeps those pipes open, and an
# INLINE caller (`$(...)`, a tool call, `Tee-Object`, `& powershell ... | ...`)
# blocks on the pipe long after the script printed RESULT=PASS and exited.
#
# HOW: CreateProcess from P/Invoke with
#   * EXTENDED_STARTUPINFO_PRESENT -- makes Windows honour the attribute list;
#   * STARTF_USESTDHANDLES with exactly stdin=NUL, stdout=<StdOutPath>,
#     stderr=<StdErrPath>, each opened with SECURITY_ATTRIBUTES.bInheritHandle =
#     TRUE (a handle must be marked inheritable to be inherited at all);
#   * PROC_THREAD_ATTRIBUTE_HANDLE_LIST whitelisting ONLY those three handles.
# The whitelist is the GUARANTEE: no OTHER handle of this process (above all its
# own stdout/stderr pipe) is inherited, so the launched child can never hold the
# caller's console open. The helper returns the PID; the caller then reads the
# DIRECT child's completion with Wait-DetachedChild (never the descendant tree).
#
# This module is the SEAM: no second pattern. It is Import-Module'd by
# launch-artifact-probe.ps1, gate-release-artifact.ps1, gate-artifact-negative.psm1
# and run-exitcode.ps1. It is NOT dot-sourced (the probe's param block and entry
# path would execute).
#
# PowerShell 5.1 standard library only. ASCII-only source (G-315).

$script:DetachTypeSource = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class FredoDetach
{
    private const int STARTF_USESTDHANDLES = 0x00000100;
    private const int EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint GENERIC_READ = 0x80000000;
    private const uint GENERIC_WRITE = 0x40000000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint OPEN_EXISTING = 3;
    private const uint CREATE_ALWAYS = 2;
    private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
    private static readonly IntPtr InvalidHandle = new IntPtr(-1);

    // PROC_THREAD_ATTRIBUTE_HANDLE_LIST: the whitelist of handles the child may
    // inherit. With this attribute set (and bInheritHandles = TRUE) nothing else
    // of the parent's handle table crosses the process boundary.
    private static readonly IntPtr ProcThreadAttributeHandleList = new IntPtr(0x00020002);

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        public int bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpReserved;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpDesktop;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode,
        ref SECURITY_ATTRIBUTES lpSecurityAttributes, uint dwCreationDisposition,
        uint dwFlagsAndAttributes, IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount,
        int dwFlags, ref IntPtr lpSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UpdateProcThreadAttribute(IntPtr lpAttributeList, uint dwFlags, IntPtr attribute,
        IntPtr lpValue, IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW(string lpApplicationName, StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, int dwCreationFlags,
        IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFOEX lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    private static void CloseQuietly(IntPtr handle)
    {
        if (handle != IntPtr.Zero && handle != InvalidHandle) { CloseHandle(handle); }
    }

    private static IntPtr OpenStandardHandle(string path, ref SECURITY_ATTRIBUTES sa)
    {
        IntPtr handle;
        if (string.IsNullOrEmpty(path))
        {
            handle = CreateFileW("NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                ref sa, OPEN_EXISTING, 0, IntPtr.Zero);
        }
        else
        {
            handle = CreateFileW(path, GENERIC_WRITE, FILE_SHARE_READ, ref sa, CREATE_ALWAYS,
                FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
        }
        if (handle == InvalidHandle)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(),
                "CreateFileW(" + (string.IsNullOrEmpty(path) ? "NUL" : path) + ")");
        }
        return handle;
    }

    // Launch a child and hand the caller the process HANDLE (out param) as well
    // as the PID. The handle is the ONLY exit-code read the caller needs: a
    // Process object re-opened by PID cannot read ExitCode once a detached child
    // has exited on this host, so the caller retains this handle, waits on it and
    // asks the kernel (GetExitCodeProcess). The handle is NEVER closed here on the
    // success path -- ownership transfers to the caller (Spec #3181 round 4).
    public static int Launch(string applicationName, string commandLine, string workingDirectory,
        string stdoutPath, string stderrPath, out IntPtr processHandle)
    {
        processHandle = IntPtr.Zero;
        IntPtr stdIn = IntPtr.Zero;
        IntPtr stdOut = IntPtr.Zero;
        IntPtr stdErr = IntPtr.Zero;
        IntPtr attributeList = IntPtr.Zero;
        IntPtr handleBuffer = IntPtr.Zero;
        bool attributeListReady = false;
        PROCESS_INFORMATION pi = new PROCESS_INFORMATION();

        // PowerShell marshals $null to "" for a string parameter, and CreateProcess
        // treats an EMPTY lpCurrentDirectory as an invalid name (error 123) rather
        // than "inherit the caller's directory". Normalise back to NULL.
        if (string.IsNullOrEmpty(workingDirectory)) { workingDirectory = null; }

        try
        {
            SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
            sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            sa.lpSecurityDescriptor = IntPtr.Zero;
            sa.bInheritHandle = 1;

            stdIn = OpenStandardHandle("NUL", ref sa);
            stdOut = OpenStandardHandle(stdoutPath, ref sa);
            stdErr = OpenStandardHandle(stderrPath, ref sa);

            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            int sizeError = Marshal.GetLastWin32Error();
            if (size == IntPtr.Zero)
            {
                throw new Win32Exception(sizeError, "InitializeProcThreadAttributeList (size probe)");
            }

            attributeList = Marshal.AllocHGlobal(size);
            if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref size))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "InitializeProcThreadAttributeList");
            }
            attributeListReady = true;

            handleBuffer = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handleBuffer, 0, stdIn);
            Marshal.WriteIntPtr(handleBuffer, IntPtr.Size, stdOut);
            Marshal.WriteIntPtr(handleBuffer, IntPtr.Size * 2, stdErr);
            if (!UpdateProcThreadAttribute(attributeList, 0, ProcThreadAttributeHandleList, handleBuffer,
                new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(),
                    "UpdateProcThreadAttribute(PROC_THREAD_ATTRIBUTE_HANDLE_LIST)");
            }

            STARTUPINFOEX startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = stdIn;
            startup.StartupInfo.hStdOutput = stdOut;
            startup.StartupInfo.hStdError = stdErr;
            startup.lpAttributeList = attributeList;

            StringBuilder line = new StringBuilder(commandLine);
            bool created = CreateProcessW(applicationName, line, IntPtr.Zero, IntPtr.Zero, true,
                EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, workingDirectory, ref startup, out pi);
            if (!created)
            {
                int launchError = Marshal.GetLastWin32Error();
                throw new Win32Exception(launchError, "CreateProcessW error=" + launchError.ToString()
                    + " app=[" + applicationName + "] cmd=[" + commandLine + "]");
            }
            processHandle = pi.hProcess;
            return pi.dwProcessId;
        }
        finally
        {
            if (pi.hThread != IntPtr.Zero) { CloseHandle(pi.hThread); }
            // Only close the process handle when ownership did NOT transfer (the
            // success path sets processHandle before returning).
            if (pi.hProcess != IntPtr.Zero && processHandle == IntPtr.Zero) { CloseHandle(pi.hProcess); }
            if (attributeList != IntPtr.Zero)
            {
                if (attributeListReady) { DeleteProcThreadAttributeList(attributeList); }
                Marshal.FreeHGlobal(attributeList);
            }
            if (handleBuffer != IntPtr.Zero) { Marshal.FreeHGlobal(handleBuffer); }
            CloseQuietly(stdIn);
            CloseQuietly(stdOut);
            CloseQuietly(stdErr);
        }
    }

    // Open a SYNCHRONIZE/QUERY handle for an already-running process. Used only
    // as the fallback when the module did not retain the launch handle.
    public static IntPtr OpenProcessHandle(int processId)
    {
        const uint SYNCHRONIZE = 0x00100000;
        const uint QUERY_LIMITED = 0x00001000;
        const uint QUERY = 0x00000400;
        IntPtr handle = OpenProcess(SYNCHRONIZE | QUERY_LIMITED, false, processId);
        if (handle == IntPtr.Zero) { handle = OpenProcess(SYNCHRONIZE | QUERY, false, processId); }
        return handle;
    }

    public static void CloseProcessHandle(IntPtr handle)
    {
        CloseQuietly(handle);
    }

    // Peek at an ALREADY-HELD handle. The caller owns the handle; it is never
    // closed here. timeoutMs < 0 waits forever, 0 returns immediately when the
    // child is still running, > 0 bounds the wait.
    // Return: >= 0 = exit code (unsigned 32-bit carried in a long);
    //         -1 = still running (WAIT_TIMEOUT);
    //         -2 = invalid handle / WAIT_FAILED;
    //         -3 = GetExitCodeProcess failed.
    public static long PeekExitCode(IntPtr handle, int timeoutMs)
    {
        const uint WAIT_OBJECT_0 = 0;
        const uint WAIT_TIMEOUT = 0x00000102;
        if (handle == IntPtr.Zero || handle == InvalidHandle) { return -2; }
        uint ms = timeoutMs < 0 ? 0xFFFFFFFF : (uint)timeoutMs;
        uint result = WaitForSingleObject(handle, ms);
        if (result == WAIT_TIMEOUT) { return -1; }
        if (result != WAIT_OBJECT_0) { return -2; }
        uint code;
        if (!GetExitCodeProcess(handle, out code)) { return -3; }
        return (long)code;
    }
}
'@

$script:DetachTypeLoaded = $false

# The retained launch handles, keyed by PID. `Start-DetachedProcess` registers
# the CreateProcess handle here; `Wait-DetachedChild` / `Get-DetachedChildExitCode`
# / `Close-DetachedChild` consume and close it. This is the ONE exit-code seam
# (Spec #3181 round 4): a Process object re-opened by PID cannot read ExitCode
# after a detached child has exited on this host.
if ($null -eq $script:DetachedHandles) { $script:DetachedHandles = @{} }

function Initialize-DetachType {
  if ($script:DetachTypeLoaded) { return }
  # A module can be Import-Module'd again (-Force) in the same AppDomain; the
  # C# type is AppDomain-global, so Add-Type would throw "type already exists".
  if ('FredoDetach' -as [type]) {
    $script:DetachTypeLoaded = $true
    return
  }
  Add-Type -TypeDefinition $script:DetachTypeSource -Language CSharp -ErrorAction Stop | Out-Null
  $script:DetachTypeLoaded = $true
}

# The ONE launch primitive for a GUI app and for a bounded child runner. Empty
# StdOutPath/StdErrPath route that stream to the NUL device. Returns the PID; the
# retained process handle is registered in the module map (keyed by PID).
function Start-DetachedProcess {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string]$ArgumentString = '',
    [string]$WorkingDirectory = '',
    [string]$StdOutPath = '',
    [string]$StdErrPath = ''
  )
  Initialize-DetachType
  $application = (Resolve-Path -LiteralPath $FilePath).Path
  $commandLine = '"' + $application + '"'
  if (-not [string]::IsNullOrWhiteSpace($ArgumentString)) { $commandLine += ' ' + $ArgumentString }
  $working = $null
  if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) {
    $working = [System.IO.Path]::GetFullPath($WorkingDirectory)
  }
  $handle = [IntPtr]::Zero
  $processId = [int][FredoDetach]::Launch($application, $commandLine, $working, $StdOutPath, $StdErrPath, [ref]$handle)
  if ($processId -gt 0 -and $handle -ne [IntPtr]::Zero) {
    # A reused PID: release the stale handle before replacing it.
    if ($script:DetachedHandles.ContainsKey($processId)) {
      try { [FredoDetach]::CloseProcessHandle([IntPtr]$script:DetachedHandles[$processId]) } catch {}
      $script:DetachedHandles.Remove($processId)
    }
    $script:DetachedHandles[$processId] = $handle
  }
  return $processId
}

# Wait for a DIRECT child (by PID) to exit and return its exit code. Uses the
# REGISTERED launch handle when present (the reliable read), falling back to
# OpenProcess only when the handle is absent (e.g. after a module re-import), and
# closes/unregisters it. Waits on the kernel handle for THAT PID only and NEVER
# walks the descendant tree -- a grandchild that lingers must not keep the caller
# waiting (G-450 / G-448's descendant-wait trap). Returns $null when the process
# is already gone or -TimeoutSecs (default 0 = unbounded) elapsed.
function Wait-DetachedChild {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [int]$TimeoutSecs = 0
  )
  Initialize-DetachType
  $timeoutMs = -1
  if ($TimeoutSecs -gt 0) {
    $timeoutMs = [int]([Math]::Min([int64]$TimeoutSecs * 1000, [int64]2147483647))
  }
  $handle = [IntPtr]::Zero
  if ($script:DetachedHandles.ContainsKey($ProcessId)) {
    $handle = [IntPtr]$script:DetachedHandles[$ProcessId]
    $script:DetachedHandles.Remove($ProcessId)
  } else {
    $handle = [FredoDetach]::OpenProcessHandle([int]$ProcessId)
    if ($handle -eq [IntPtr]::Zero) { return $null }
  }
  try {
    $raw = [long][FredoDetach]::PeekExitCode($handle, [int]$timeoutMs)
    if ($raw -lt 0) { return $null }
    # Exit code arrives as an unsigned 32-bit value; convert to the signed int the
    # OS reports (e.g. 0xC0000135 -> -1073741515) so callers match native codes.
    $unsigned = [System.BitConverter]::ToUInt32([System.BitConverter]::GetBytes([long]$raw), 0)
    return [System.BitConverter]::ToInt32([System.BitConverter]::GetBytes([uint32]$unsigned), 0)
  } finally {
    [FredoDetach]::CloseProcessHandle($handle)
  }
}

# NON-BLOCKING exit-code read for a launched child (Spec #3181 round 4). Uses the
# registered launch handle (fallback: OpenProcess) and a zero-timeout wait, so it
# never blocks the caller's own observation window. Returns
#   Status='observed'    Code=<signed int32>
#   Status='not-exited'  Code=$null
#   Status='unreadable'  Code=$null
# The registered handle is NOT closed here -- Close-DetachedChild owns it (a later
# non-blocking read of the same PID must still work during the window).
function Get-DetachedChildExitCode {
  param([Parameter(Mandatory = $true)][int]$ProcessId)
  Initialize-DetachType
  $handle = [IntPtr]::Zero
  $opened = $false
  if ($script:DetachedHandles.ContainsKey($ProcessId)) {
    $handle = [IntPtr]$script:DetachedHandles[$ProcessId]
  } else {
    $handle = [FredoDetach]::OpenProcessHandle([int]$ProcessId)
    if ($handle -eq [IntPtr]::Zero) {
      return [pscustomobject]@{ Status = 'unreadable'; Code = $null }
    }
    $opened = $true
  }
  try {
    $raw = [long][FredoDetach]::PeekExitCode($handle, 0)
    if ($raw -eq -1) { return [pscustomobject]@{ Status = 'not-exited'; Code = $null } }
    if ($raw -lt 0) { return [pscustomobject]@{ Status = 'unreadable'; Code = $null } }
    $unsigned = [System.BitConverter]::ToUInt32([System.BitConverter]::GetBytes([long]$raw), 0)
    $signed = [System.BitConverter]::ToInt32([System.BitConverter]::GetBytes([uint32]$unsigned), 0)
    return [pscustomobject]@{ Status = 'observed'; Code = $signed }
  } finally {
    if ($opened) { [FredoDetach]::CloseProcessHandle($handle) }
  }
}

# Release the retained launch handle for a child the caller is done observing.
# Idempotent: a PID with no registered handle is a no-op.
function Close-DetachedChild {
  param([Parameter(Mandatory = $true)][int]$ProcessId)
  Initialize-DetachType
  if ($script:DetachedHandles.ContainsKey($ProcessId)) {
    $handle = [IntPtr]$script:DetachedHandles[$ProcessId]
    $script:DetachedHandles.Remove($ProcessId)
    [FredoDetach]::CloseProcessHandle($handle)
  }
}

Export-ModuleMember -Function @(
  'Initialize-DetachType',
  'Start-DetachedProcess',
  'Wait-DetachedChild',
  'Get-DetachedChildExitCode',
  'Close-DetachedChild'
)
