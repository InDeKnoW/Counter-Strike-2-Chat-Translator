using System;
using System.Linq;
using System.Windows;

namespace CS2ChatTranslator;

/// <summary>
/// Interaction logic for App.xaml
/// </summary>
public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        if (e.Args.Length > 0 && e.Args[0] == "--press-key")
        {
            var keys = e.Args.Skip(1).ToArray();
            NativeKeySender.SendKeysToCs2(keys);
            Environment.Exit(0);
            return;
        }

        base.OnStartup(e);
    }
}
